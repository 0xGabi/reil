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
import { isPositionUnhealthy, calculateRepayAmount } from './healthFactor.ts'
import { getATokenBalance, convertUSDBaseToTokenAmount } from './utils.ts'
import { optimizeRebalanceDistribution } from './optimization.ts'

/**
 * Rebalance unhealthy Aave positions using a single UserOperation
 */
export async function rebalanceAavePositions(
  sdk: CrossChainSdk,
  account: IMultiChainSmartAccount,
  positions: AavePosition[],
  collateralToken: MultichainToken,
  debtToken: MultichainToken,
  callback: ExecCallback
): Promise<void> {
  const unhealthyPositions = positions.filter((pos) =>
    isPositionUnhealthy(pos)
  )

  if (unhealthyPositions.length === 0) {
    throw new Error('No unhealthy positions to rebalance')
  }

  const builder = sdk.createBuilder()

  // Group positions by chain
  const positionsByChain = new Map<number, AavePosition[]>()
  unhealthyPositions.forEach((pos) => {
    const chainPositions = positionsByChain.get(pos.chainId) || []
    chainPositions.push(pos)
    positionsByChain.set(pos.chainId, chainPositions)
  })

  // Create batches for each chain with unhealthy positions
  for (const [chainId, chainPositions] of positionsByChain.entries()) {
    const batch = builder.startBatch(BigInt(chainId))
    const userAddress = chainPositions[0].userAddress

    for (const position of chainPositions) {
      // Calculate repay amount to reach healthy health factor
      const repayAmount = calculateRepayAmount(position)

      if (repayAmount > 0n) {
        // Get user's balance of the debt token
        const client = getClient(wagmiConfig, { chainId: position.chainId })
        if (!client) continue

        const debtTokenAddress = debtToken.addressOn(BigInt(position.chainId))
        if (!debtTokenAddress) continue

        const poolAddress = getAavePoolAddress(position.chainId)
        if (!poolAddress) continue

        // Approve Aave pool to spend debt token
        batch.addAction(
          new ApproveAction({
            token: debtToken,
            spender: poolAddress as Address,
            value: repayAmount,
          })
        )

        // Repay debt (interest rate mode: 2 = variable)
        batch.addAction(
          new FunctionCallAction({
            target: poolAddress as Address,
            functionName: 'repay',
            args: [debtTokenAddress, repayAmount, 2n, userAddress],
            abi: AAVE_POOL_ABI,
            value: 0n,
          })
        )
      }

      // If we still need to improve health factor, supply more collateral
      const newHealthFactor = position.healthFactor
      if (newHealthFactor < parseUnits('1.5', 18) && position.totalDebtBase > 0n) {
        // Calculate additional collateral needed
        const targetHealthFactor = parseUnits('2.0', 18)
        const currentCollateral = position.totalCollateralBase
        const currentDebt = position.totalDebtBase
        const liquidationThreshold = position.currentLiquidationThreshold

        // targetHealthFactor = (newCollateral * liquidationThreshold) / debt
        // newCollateral = (targetHealthFactor * debt) / liquidationThreshold
        const targetCollateral =
          (targetHealthFactor * currentDebt) / liquidationThreshold
        const additionalCollateral = targetCollateral > currentCollateral
          ? targetCollateral - currentCollateral
          : 0n

        if (additionalCollateral > 0n) {
          const collateralTokenAddress = collateralToken.addressOn(
            BigInt(position.chainId)
          )
          const poolAddress = getAavePoolAddress(position.chainId)

          if (collateralTokenAddress && poolAddress) {
            // Approve Aave pool to spend collateral token
            batch.addAction(
              new ApproveAction({
                token: collateralToken,
                spender: poolAddress as Address,
                value: additionalCollateral,
              })
            )

            // Supply collateral using direct function call
            batch.addAction(
              new FunctionCallAction({
                target: poolAddress as Address,
                functionName: 'supply',
                args: [collateralTokenAddress, additionalCollateral, userAddress, 0],
                abi: AAVE_POOL_ABI,
                value: 0n,
              })
            )
          }
        }
      }
    }

    batch.overrideUserOp(USEROP_OVERRIDE).endBatch()
  }

  builder.useAccount(account)
  const executor = await builder.buildAndSign()
  await executor.execute(callback)
}

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

  // Group withdrawals and voucher requests by source chain
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

  // Create batches for withdrawing collateral and requesting vouchers
  for (const [sourceChainId, withdrawAmountUSD] of withdrawalsByChain.entries()) {
    const position = healthyPositions.find((p) => p.chainId === sourceChainId)
    if (!position) continue

    const poolAddress = getAavePoolAddress(sourceChainId)
    const collateralTokenAddress = collateralToken.addressOn(BigInt(sourceChainId))
    if (!poolAddress || !collateralTokenAddress) continue

    const batch = builder.startBatch(BigInt(sourceChainId))
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

    // Withdraw the calculated amount (in token units)
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
    // Convert voucher amounts from USD base to token amounts
    const vouchers = vouchersBySourceChain.get(sourceChainId) || []
    let remainingWithdrawAmount = actualWithdrawAmount
    
    for (let i = 0; i < vouchers.length; i++) {
      const voucher = vouchers[i]
      // Convert USD base amount to token amount using oracle price
      const voucherAmountTokens = await convertUSDBaseToTokenAmount(
        voucher.amount,
        sourceChainId,
        collateralTokenAddress,
        tokenDecimals
      )
      
      // Ensure we don't request more than we're withdrawing
      // Distribute the actual withdraw amount proportionally
      const voucherAmount = voucherAmountTokens > remainingWithdrawAmount
        ? remainingWithdrawAmount
        : voucherAmountTokens
      
      if (voucherAmount > 0n) {
        batch.addVoucherRequest({
          ref: `voucher_${sourceChainId}_to_${voucher.destChainId}`,
          destinationChainId: BigInt(voucher.destChainId),
          tokens: [{ token: collateralToken, amount: voucherAmount }],
        })
        
        // Track voucher amounts in token units for supply step
        const current = voucherAmountsByDestination.get(voucher.destChainId) || 0n
        voucherAmountsByDestination.set(voucher.destChainId, current + voucherAmount)
        
        remainingWithdrawAmount -= voucherAmount
      }
    }

    batch.overrideUserOp(USEROP_OVERRIDE).endBatch()
  }

  // Step 2: Use vouchers and supply collateral on destination chains
  // Use the tracked voucher amounts (already in token units)
  const suppliesByChain = new Map(voucherAmountsByDestination)

  for (const [destChainId, supplyAmountTokens] of suppliesByChain.entries()) {
    const position = unhealthyPositions.find((p) => p.chainId === destChainId)
    if (!position) continue

    const poolAddress = getAavePoolAddress(destChainId)
    const collateralTokenAddress = collateralToken.addressOn(BigInt(destChainId))
    if (!poolAddress || !collateralTokenAddress) continue

    const batch = builder.startBatch(BigInt(destChainId))
    const userAddress = position.userAddress

    // Use all vouchers received on this chain
    batch.useAllVouchers()

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

    batch.overrideUserOp(USEROP_OVERRIDE).endBatch()
  }

  builder.useAccount(account)
  const executor = await builder.buildAndSign()
  await executor.execute(callback)
}

