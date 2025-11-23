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
import { USEROP_OVERRIDE } from './constants.ts'
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
  // Due to SDK limitation: only ONE voucher per source->destination pair
  // Workaround: Chain vouchers - send full amount to first destination, then chain to next destinations
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

  // Step 1: Create batches for source chains - send FULL withdrawal amount to FIRST destination only
  // Due to SDK limitation, we can only send one voucher per source chain
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

    // Due to SDK limitation: only ONE voucher per source chain
    // Send FULL withdrawal amount to FIRST destination only
    const vouchers = vouchersBySourceChain.get(sourceChainId) || []
    
    if (vouchers.length === 0) {
      // No vouchers to create, but batch already has withdraw action
      batch.overrideUserOp(USEROP_OVERRIDE).endBatch()
      continue
    }

    // Sort destinations by priority (worst health factor first)
    const sortedVouchers = [...vouchers].sort((a, b) => {
      const posA = unhealthyPositions.find(p => p.chainId === a.destChainId)
      const posB = unhealthyPositions.find(p => p.chainId === b.destChainId)
      if (!posA) return 1
      if (!posB) return -1
      if (posA.healthFactor === 0n) return -1
      if (posB.healthFactor === 0n) return 1
      return posA.healthFactor < posB.healthFactor ? -1 : 1
    })

    // Send FULL withdrawal amount to FIRST destination
    const firstDestination = sortedVouchers[0]
    const voucherRef = `voucher_${sourceChainId}_to_${firstDestination.destChainId}`
    
    batch.addVoucherRequest({
      ref: voucherRef,
      destinationChainId: BigInt(firstDestination.destChainId),
      tokens: [{ token: collateralToken, amount: actualWithdrawAmount }],
    })
    
    // Track the full amount going to first destination (will be chained from there)
    voucherAmountsByDestination.set(firstDestination.destChainId, actualWithdrawAmount)
    voucherRefsByDestination.set(firstDestination.destChainId, [voucherRef])

    batch.overrideUserOp(USEROP_OVERRIDE).endBatch()
  }

  // Step 2: Build chain order for each source
  // Map: sourceChainId -> [firstDest, secondDest, thirdDest, ...]
  const chainOrderBySource = new Map<number, number[]>()
  for (const [sourceChainId, vouchers] of vouchersBySourceChain.entries()) {
    const sortedVouchers = [...vouchers].sort((a, b) => {
      const posA = unhealthyPositions.find(p => p.chainId === a.destChainId)
      const posB = unhealthyPositions.find(p => p.chainId === b.destChainId)
      if (!posA) return 1
      if (!posB) return -1
      if (posA.healthFactor === 0n) return -1
      if (posB.healthFactor === 0n) return 1
      return posA.healthFactor < posB.healthFactor ? -1 : 1
    })
    chainOrderBySource.set(sourceChainId, sortedVouchers.map(v => v.destChainId))
  }

  // Step 3: Process destination chains in chain order
  // For each destination: use voucher, supply what's needed, forward remainder to next destination
  const processedDestinations = new Set<number>()
  const needsByDestination = new Map(optimalSupplies)

  // Process destinations in the order they appear in chains
  for (const [sourceChainId, chainOrder] of chainOrderBySource.entries()) {
    if (chainOrder.length === 0) continue

    const sourcePosition = healthyPositions.find(p => p.chainId === sourceChainId)
    if (!sourcePosition) continue

    const sourcePoolAddress = getAavePoolAddress(sourceChainId)
    const sourceCollateralTokenAddress = collateralToken.addressOn(BigInt(sourceChainId))
    if (!sourcePoolAddress || !sourceCollateralTokenAddress) continue

    const sourceClient = getClient(wagmiConfig, { chainId: sourceChainId })
    if (!sourceClient) continue

    const sourceTokenDecimals = await readContract(sourceClient, {
      address: sourceCollateralTokenAddress,
      abi: erc20Abi,
      functionName: 'decimals',
    }) as number

    // Get the full withdrawal amount in tokens
    const sourceWithdrawAmountUSD = withdrawalsByChain.get(sourceChainId) || 0n
    const sourceWithdrawAmountTokens = await convertUSDBaseToTokenAmount(
      sourceWithdrawAmountUSD,
      sourceChainId,
      sourceCollateralTokenAddress,
      sourceTokenDecimals
    )

    // Process each destination in the chain
    let remainingAmount = sourceWithdrawAmountTokens

    for (let i = 0; i < chainOrder.length; i++) {
      const destChainId = chainOrder[i]
      if (processedDestinations.has(destChainId)) continue

      const position = unhealthyPositions.find((p) => p.chainId === destChainId)
      if (!position) continue

      const poolAddress = getAavePoolAddress(destChainId)
      const collateralTokenAddress = collateralToken.addressOn(BigInt(destChainId))
      if (!poolAddress || !collateralTokenAddress) continue

      const batch = getOrCreateBatch(destChainId)
      const userAddress = position.userAddress

      // Get token decimals for destination chain
      const client = getClient(wagmiConfig, { chainId: destChainId })
      if (!client) continue

      const tokenDecimals = await readContract(client, {
        address: collateralTokenAddress,
        abi: erc20Abi,
        functionName: 'decimals',
      }) as number

      // Calculate how much this destination needs (in token units)
      const neededUSD = needsByDestination.get(destChainId) || 0n
      const neededTokens = await convertUSDBaseToTokenAmount(
        neededUSD,
        destChainId,
        collateralTokenAddress,
        tokenDecimals
      )

      // Use vouchers for this destination
      // - If first destination (i === 0): use voucher from source chain
      // - If subsequent destination (i > 0): use voucher from previous destination in chain
      if (i === 0) {
        // First destination: use voucher from source chain
        const voucherRefs = voucherRefsByDestination.get(destChainId) || []
        for (const voucherRef of voucherRefs) {
          batch.useVoucher(voucherRef)
        }
      } else {
        // Subsequent destination: use voucher from previous destination
        const prevDestChainId = chainOrder[i - 1]
        const prevVoucherRef = `voucher_${prevDestChainId}_to_${destChainId}`
        batch.useVoucher(prevVoucherRef)
      }

      // Calculate how much to supply (min of needed and available)
      const supplyAmount = remainingAmount < neededTokens ? remainingAmount : neededTokens
      const remainder = remainingAmount - supplyAmount

      if (supplyAmount > 0n) {
        // Approve Aave pool to spend collateral token
        batch.addAction(
          new ApproveAction({
            token: collateralToken,
            spender: poolAddress as Address,
            value: supplyAmount,
          })
        )

        // Supply collateral to Aave
        batch.addAction(
          new FunctionCallAction({
            target: poolAddress as Address,
            functionName: 'supply',
            args: [collateralTokenAddress, supplyAmount, userAddress, 0],
            abi: AAVE_POOL_ABI,
            value: 0n,
          })
        )

        // Note: We don't need to update needsByDestination since we're processing destinations
        // in order and forwarding remainders. Each destination gets what it can from the chain.
      }

      // If there's a remainder and more destinations in the chain, create voucher to next destination
      if (remainder > 0n && i < chainOrder.length - 1) {
        const nextDestChainId = chainOrder[i + 1]
        const nextVoucherRef = `voucher_${destChainId}_to_${nextDestChainId}`
        
        batch.addVoucherRequest({
          ref: nextVoucherRef,
          destinationChainId: BigInt(nextDestChainId),
          tokens: [{ token: collateralToken, amount: remainder }],
        })

        // Track voucher for next destination
        const nextRefs = voucherRefsByDestination.get(nextDestChainId) || []
        nextRefs.push(nextVoucherRef)
        voucherRefsByDestination.set(nextDestChainId, nextRefs)
      }

      remainingAmount = remainder
      processedDestinations.add(destChainId)
      batch.overrideUserOp(USEROP_OVERRIDE).endBatch()
    }
  }

  builder.useAccount(account)
  const executor = await builder.buildAndSign()
  await executor.execute(callback)
}

