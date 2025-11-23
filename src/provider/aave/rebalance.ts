import { getClient } from 'wagmi/actions'
import { readContract } from 'viem/actions'
import { type Address, parseUnits, erc20Abi } from 'viem'

import {
  CrossChainSdk,
  FunctionCallAction,
  type ExecCallback,
  type IMultiChainSmartAccount,
  MultichainToken,
  ApproveAction,
} from '@eil-protocol/sdk'

import { AAVE_POOL_ABI, getAavePoolAddress } from '../../utils/constants.ts'
import { wagmiConfig } from '../wagmiConfig.ts'
import { type AavePosition } from './types.ts'
import { isPositionUnhealthy } from './healthFactor.ts'
import { getATokenBalance, convertUSDBaseToTokenAmount } from './utils.ts'
import { optimizeRebalanceDistribution } from './optimization.ts'


/**
 * Cross-chain rebalance Aave positions by:
 * 1. Checking health factors across all chains
 * 2. Identifying positions needing collateral (bad health factor)
 * 3. Optimally calculating withdrawal amounts from healthy positions
 * 4. Optimally calculating supply amounts for unhealthy positions
 * 5. Withdrawing collateral from healthy positions and creating voucher requests
 * 6. Using vouchers on destination chains and supplying collateral
 * 
 * Ensures all positions end up with health factor >= minHealthFactor (default 1.2)
 */
export async function crossChainRebalanceAavePositions(
  sdk: CrossChainSdk,
  account: IMultiChainSmartAccount,
  positions: AavePosition[],
  collateralToken: MultichainToken,
  callback: ExecCallback,
  minHealthFactor: bigint = parseUnits('1.2', 18)
): Promise<void> {
  // Separate positions into unhealthy (need collateral) and healthy (can provide collateral)
  const unhealthyPositions = positions.filter((pos) =>
    isPositionUnhealthy(pos, minHealthFactor)
  )
  const healthyPositions = positions.filter((pos) =>
    !isPositionUnhealthy(pos, minHealthFactor) && pos.totalCollateralBase > 0n
  )

  if (unhealthyPositions.length === 0) {
    throw new Error('No unhealthy positions to rebalance')
  }

  if (healthyPositions.length === 0) {
    throw new Error('No healthy positions to provide collateral')
  }

  // Use optimal distribution algorithm to calculate withdrawals and supplies
  const { withdrawals: optimalWithdrawals, supplies: optimalSupplies } =
    optimizeRebalanceDistribution(healthyPositions, unhealthyPositions, minHealthFactor)

  // Calculate total collateral needed and available
  const totalNeeded = Array.from(optimalSupplies.values()).reduce(
    (sum, amount) => sum + amount,
    0n
  )
  const totalAvailable = Array.from(optimalWithdrawals.values()).reduce(
    (sum, amount) => sum + amount,
    0n
  )

  if (totalAvailable < totalNeeded) {
    console.warn(
      `Not enough collateral available. Needed: ${totalNeeded}, Available: ${totalAvailable}. ` +
      `Will distribute proportionally to keep all positions above ${minHealthFactor.toString()} health factor.`
    )
  }

  const builder = sdk.createBuilder()

  // Step 1: Create voucher requests mapping withdrawals to supplies
  // Distribute withdrawals from source chains to destination chains optimally
  const voucherRequests: Array<{
    sourceChainId: number
    destinationChainId: number
    amount: bigint
  }> = []

  // Create a mapping of source -> destination transfers
  // Prioritize chains with worst health factors for receiving collateral
  const sortedUnhealthy = [...unhealthyPositions].sort((a, b) => {
    if (a.healthFactor === 0n) return 1
    if (b.healthFactor === 0n) return -1
    return a.healthFactor < b.healthFactor ? -1 : 1
  })

  const remainingSupplies = new Map(optimalSupplies)
  const remainingWithdrawals = new Map(optimalWithdrawals)

  // Distribute withdrawals to supplies optimally
  for (const position of sortedUnhealthy) {
    const needed = remainingSupplies.get(position.chainId) || 0n
    if (needed === 0n) continue

    // Find healthy positions to withdraw from
    const sortedHealthy = [...healthyPositions]
      .filter((p) => (remainingWithdrawals.get(p.chainId) || 0n) > 0n)
      .sort((a, b) => {
        // Prioritize positions with higher health factors
        if (a.healthFactor === 0n) return 1
        if (b.healthFactor === 0n) return -1
        return a.healthFactor > b.healthFactor ? -1 : 1
      })

    let remainingNeed = needed
    for (const healthyPos of sortedHealthy) {
      if (remainingNeed === 0n) break

      const sourceChainId = healthyPos.chainId
      if (sourceChainId === position.chainId) continue // Skip same chain

      const available = remainingWithdrawals.get(sourceChainId) || 0n
      if (available === 0n) continue

      const transferAmount = available < remainingNeed ? available : remainingNeed
      if (transferAmount > 0n) {
        voucherRequests.push({
          sourceChainId,
          destinationChainId: position.chainId,
          amount: transferAmount,
        })

        remainingNeed -= transferAmount
        remainingWithdrawals.set(sourceChainId, available - transferAmount)
      }
    }

    // Update remaining supplies
    remainingSupplies.set(position.chainId, remainingNeed)
  }

  // Group voucher requests by source chain
  const withdrawalsByChain = new Map<number, bigint>()
  const vouchersBySourceChain = new Map<number, Array<{ destChainId: number; amount: bigint }>>()

  for (const voucher of voucherRequests) {
    const current = withdrawalsByChain.get(voucher.sourceChainId) || 0n
    withdrawalsByChain.set(voucher.sourceChainId, current + voucher.amount)

    const vouchers = vouchersBySourceChain.get(voucher.sourceChainId) || []
    vouchers.push({ destChainId: voucher.destinationChainId, amount: voucher.amount })
    vouchersBySourceChain.set(voucher.sourceChainId, vouchers)
  }

  // Track actual voucher amounts in token units (for supply step)
  const voucherAmountsByDestination = new Map<number, bigint>()
  // Track voucher refs by destination chain (for useVoucher calls)
  const voucherRefsByDestination = new Map<number, string[]>()
  // Track batches by chainId to prevent duplicate batch creation (like stitchSDK does)
  const batchesByChain = new Map<number, ReturnType<typeof builder.startBatch>>()

  // Helper function to get or create batch (similar to stitchSDK's findOrCreateBatch)
  const getOrCreateBatch = (chainId: number) => {
    const existing = batchesByChain.get(chainId)
    if (existing) return existing
    const batch = builder.startBatch(BigInt(chainId))
    batchesByChain.set(chainId, batch)
    return batch
  }

  // Create one batch per source chain with multiple voucher requests
  for (const [sourceChainId, withdrawAmountUSD] of withdrawalsByChain.entries()) {
    const position = healthyPositions.find((p) => p.chainId === sourceChainId)
    if (!position) continue

    const poolAddress = getAavePoolAddress(sourceChainId)
    const collateralTokenAddress = collateralToken.addressOn(BigInt(sourceChainId))
    if (!poolAddress || !collateralTokenAddress) continue

    // Get or create batch for this source chain (prevents duplicate batches)
    const batch = getOrCreateBatch(sourceChainId)
    const userAddress = position.userAddress

    // Get actual aToken balance and convert USD base amount to token amount
    const client = getClient(wagmiConfig, { chainId: sourceChainId })
    if (!client) continue

    // Get token decimals
    const tokenDecimals = await readContract(client, {
      address: collateralTokenAddress,
      abi: erc20Abi,
      functionName: 'decimals',
    }) as number

    // Get actual aToken balance
    const aTokenBalance = await getATokenBalance(
      sourceChainId,
      userAddress,
      collateralTokenAddress,
      poolAddress
    )

    // Convert USD base amount to token amount using oracle price
    const withdrawAmountTokens = await convertUSDBaseToTokenAmount(
      withdrawAmountUSD,
      sourceChainId,
      collateralTokenAddress,
      tokenDecimals
    )

    // Use the minimum of: calculated withdraw amount and actual available balance
    const actualWithdrawAmount = aTokenBalance > 0n && aTokenBalance < withdrawAmountTokens
      ? aTokenBalance
      : withdrawAmountTokens

    if (actualWithdrawAmount === 0n) {
      console.warn(`No withdrawable balance on chain ${sourceChainId}`)
      continue
    }

    // Withdraw the total calculated amount (in token units) for all destinations
    batch.addAction(
      new FunctionCallAction({
        target: poolAddress as Address,
        functionName: 'withdraw',
        args: [collateralTokenAddress, actualWithdrawAmount, userAddress],
        abi: AAVE_POOL_ABI,
        value: 0n,
      })
    )

    // Create voucher requests for each destination chain
    // Each voucher request has a unique ref
    const vouchers = vouchersBySourceChain.get(sourceChainId) || []
    
    if (vouchers.length === 0) {
      // No vouchers to create, but batch already has withdraw action
      continue
    }

    // Convert voucher amounts from USD base to token amounts and distribute proportionally
    const voucherAmountsInTokens: Array<{ destChainId: number; amount: bigint }> = []
    let totalVoucherTokens = 0n
    
    for (const voucher of vouchers) {
      const voucherAmountTokens = await convertUSDBaseToTokenAmount(
        voucher.amount,
        sourceChainId,
        collateralTokenAddress,
        tokenDecimals
      )
      voucherAmountsInTokens.push({ destChainId: voucher.destChainId, amount: voucherAmountTokens })
      totalVoucherTokens += voucherAmountTokens
    }
    
    // Distribute actual withdrawal amount proportionally to avoid rounding issues
    let remainingWithdrawAmount = actualWithdrawAmount
    
    for (let i = 0; i < voucherAmountsInTokens.length; i++) {
      const voucher = voucherAmountsInTokens[i]
      let voucherAmount: bigint
      
      if (i === voucherAmountsInTokens.length - 1) {
        // Last voucher gets remaining amount to ensure exact match
        voucherAmount = remainingWithdrawAmount
      } else if (totalVoucherTokens > 0n) {
        // Proportional distribution: (voucherAmount / totalVoucherTokens) * actualWithdrawAmount
        voucherAmount = (voucher.amount * actualWithdrawAmount) / totalVoucherTokens
      } else {
        voucherAmount = 0n
      }
      
      // Ensure we don't exceed remaining amount
      voucherAmount = voucherAmount > remainingWithdrawAmount ? remainingWithdrawAmount : voucherAmount
      
      if (voucherAmount > 0n) {
        // Create voucher request with unique ref for this source->destination pair
        const voucherRef = `voucher_${sourceChainId}_to_${voucher.destChainId}`
        batch.addVoucherRequest({
          ref: voucherRef,
          destinationChainId: BigInt(voucher.destChainId),
          tokens: [{ token: collateralToken, amount: voucherAmount }],
        })
        
        // Track voucher amounts in token units for supply step
        const current = voucherAmountsByDestination.get(voucher.destChainId) || 0n
        voucherAmountsByDestination.set(voucher.destChainId, current + voucherAmount)
        
        // Track voucher refs by destination for useVoucher calls
        const refs = voucherRefsByDestination.get(voucher.destChainId) || []
        refs.push(voucherRef)
        voucherRefsByDestination.set(voucher.destChainId, refs)
        
        remainingWithdrawAmount -= voucherAmount
      }
    }
  }

  // Step 2: Use vouchers and supply collateral on destination chains
  // Use specific voucher refs instead of useAllVouchers()
  const suppliesByChain = new Map(voucherAmountsByDestination)

  for (const [destChainId, supplyAmountTokens] of suppliesByChain.entries()) {
    const position = unhealthyPositions.find((p) => p.chainId === destChainId)
    if (!position) continue

    const poolAddress = getAavePoolAddress(destChainId)
    const collateralTokenAddress = collateralToken.addressOn(BigInt(destChainId))
    if (!poolAddress || !collateralTokenAddress) continue

    // Get or create batch for this destination chain (prevents duplicate batches)
    const batch = getOrCreateBatch(destChainId)
    const userAddress = position.userAddress

    // Use specific vouchers by ref (one useVoucher call per voucher ref)
    const voucherRefs = voucherRefsByDestination.get(destChainId) || []
    for (const voucherRef of voucherRefs) {
      batch.useVoucher(voucherRef)
    }

    if (supplyAmountTokens > 0n) {
      // Approve Aave pool to spend collateral token
      batch.addAction(
        new ApproveAction({
          token: collateralToken,
          spender: poolAddress as Address,
          value: supplyAmountTokens,
        })
      )

      // Supply collateral to Aave (amount is now in token units)
      batch.addAction(
        new FunctionCallAction({
          target: poolAddress as Address,
          functionName: 'supply',
          args: [collateralTokenAddress, supplyAmountTokens, userAddress, 0],
          abi: AAVE_POOL_ABI,
          value: 0n,
        })
      )
    }
  }

  builder.useAccount(account)
  const executor = await builder.buildAndSign()
  await executor.execute(callback)
}

