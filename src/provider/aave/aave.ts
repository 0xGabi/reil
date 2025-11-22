import { getClient } from 'wagmi/actions'
import { readContract } from 'viem/actions'
import { type Address, parseUnits } from 'viem'

import {
  CrossChainSdk,
  FunctionCallAction,
  type ExecCallback,
  type IMultiChainSmartAccount,
  MultichainToken,
  ApproveAction,
} from '@eil-protocol/sdk'

// Import Aave components - these should be available from the SDK
// If not available, we'll need to import from stitchSDK directly
import { AAVE_POOL_ABI, getAavePoolAddress } from '../../utils/constants.ts'

import { wagmiConfig } from '../wagmiConfig.ts'

export interface AavePosition {
  chainId: number
  healthFactor: bigint
  totalCollateralBase: bigint
  totalDebtBase: bigint
  availableBorrowsBase: bigint
  currentLiquidationThreshold: bigint
  ltv: bigint
  userAddress: Address
}

export interface AaveReserveData {
  asset: Address
  currentATokenBalance: bigint
  currentStableDebt: bigint
  currentVariableDebt: bigint
  usageAsCollateralEnabled: boolean
}

const useropOverride = {
  maxFeePerGas: 1000000000n,
  maxPriorityFeePerGas: 10n
}

/**
 * Fetch Aave position data for a user on a specific chain
 */
export async function fetchAavePosition(
  chainId: number,
  userAddress: Address
): Promise<AavePosition | null> {
  const client = getClient(wagmiConfig, { chainId })
  if (!client) {
    throw new Error(`Client not initialized for chain ${chainId}`)
  }

  const poolAddress = getAavePoolAddress(chainId)

  if (!poolAddress) {
    console.warn(`Aave pool not found on chain ${chainId}`)
    return null
  }

  try {
    const accountData = await readContract(client, {
      address: poolAddress as Address,
      abi: AAVE_POOL_ABI,
      functionName: 'getUserAccountData',
      args: [userAddress],
    }) as [bigint, bigint, bigint, bigint, bigint, bigint]

    const [
      totalCollateralBase,
      totalDebtBase,
      availableBorrowsBase,
      currentLiquidationThreshold,
      ltv,
      healthFactor,
    ] = accountData

    return {
      chainId,
      healthFactor,
      totalCollateralBase,
      totalDebtBase,
      availableBorrowsBase,
      currentLiquidationThreshold,
      ltv,
      userAddress,
    }
  } catch (error) {
    console.error(`Error fetching Aave position on chain ${chainId}:`, error)
    return null
  }
}

/**
 * Fetch Aave positions across multiple chains
 */
export async function fetchAavePositions(
  chainIds: number[],
  account: IMultiChainSmartAccount
): Promise<AavePosition[]> {
  const positions = await Promise.all(
    chainIds.map(async (chainId) => {
      const smartAccount = account.contractOn(BigInt(chainId))
      if (!smartAccount?.address) return null
      return fetchAavePosition(chainId, smartAccount.address)
    })
  )

  return positions.filter((pos): pos is AavePosition => pos !== null)
}

/**
 * Check if a position is unhealthy (health factor below threshold)
 */
export function isPositionUnhealthy(
  position: AavePosition,
  threshold: bigint = parseUnits('1.5', 18)
): boolean {
  // Health factor of 0 means no debt, which is healthy
  if (position.healthFactor === 0n) return false
  // Health factor below threshold is unhealthy
  return position.healthFactor < threshold
}

/**
 * Calculate the amount needed to repay to reach target health factor
 */
export function calculateRepayAmount(
  position: AavePosition,
  targetHealthFactor: bigint = parseUnits('2.0', 18)
): bigint {
  if (position.totalDebtBase === 0n || position.healthFactor === 0n) {
    return 0n
  }

  // Current health factor = (collateral * liquidationThreshold) / debt
  // Target: (collateral * liquidationThreshold) / (debt - repayAmount) = targetHealthFactor
  // Solving for repayAmount:
  // repayAmount = debt - (collateral * liquidationThreshold) / targetHealthFactor

  const numerator = position.totalCollateralBase * position.currentLiquidationThreshold
  const targetDebt = numerator / targetHealthFactor
  const repayAmount = position.totalDebtBase - targetDebt

  return repayAmount > 0n ? repayAmount : 0n
}

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

    batch.overrideUserOp(useropOverride).endBatch()
  }

  builder.useAccount(account)
  const executor = await builder.buildAndSign()
  await executor.execute(callback)
}

/**
 * Calculate the collateral amount needed to improve health factor to target
 */
export function calculateCollateralNeeded(
  position: AavePosition,
  targetHealthFactor: bigint = parseUnits('2.0', 18)
): bigint {
  if (position.totalDebtBase === 0n || position.healthFactor === 0n) {
    return 0n
  }

  // Health factor = (collateral * liquidationThreshold) / debt
  // Target: (newCollateral * liquidationThreshold) / debt = targetHealthFactor
  // newCollateral = (targetHealthFactor * debt) / liquidationThreshold
  const targetCollateral =
    (targetHealthFactor * position.totalDebtBase) / position.currentLiquidationThreshold
  const additionalCollateral = targetCollateral > position.totalCollateralBase
    ? targetCollateral - position.totalCollateralBase
    : 0n

  return additionalCollateral
}

/**
 * Calculate the maximum amount that can be withdrawn from a position without making it unhealthy
 * 
 * Note: All values are in USD base (8 decimals)
 * - totalCollateralBase: USD value in 8 decimals
 * - totalDebtBase: USD value in 8 decimals  
 * - currentLiquidationThreshold: basis points (4 decimals, e.g., 8000 = 80%)
 * - minHealthFactor: 18 decimals (e.g., 1.5 * 10^18)
 * 
 * Health factor formula: HF = (collateral * liquidationThreshold) / debt
 * To maintain minHealthFactor: minCollateral = (minHealthFactor * debt) / liquidationThreshold
 * 
 * Decimal handling:
 * - minHealthFactor has 18 decimals
 * - totalDebtBase has 8 decimals
 * - currentLiquidationThreshold has 4 decimals
 * - Result needs 8 decimals (USD base)
 * 
 * Calculation: (minHealthFactor * totalDebtBase * 10^4) / (currentLiquidationThreshold * 10^18)
 * = (minHealthFactor * totalDebtBase) / (currentLiquidationThreshold * 10^14)
 */
export function calculateMaxWithdrawable(
  position: AavePosition,
  minHealthFactor: bigint = parseUnits('1.5', 18)
): bigint {
  if (position.totalDebtBase === 0n || position.healthFactor === 0n) {
    // No debt, can withdraw all collateral (but we'll leave some buffer)
    return position.totalCollateralBase / 2n // Withdraw at most 50% if no debt
  }

  // Health factor = (collateral * liquidationThreshold) / debt
  // Minimum collateral needed: (minHealthFactor * debt) / liquidationThreshold
  // 
  // Decimal precision fix:
  // - minHealthFactor: 18 decimals
  // - totalDebtBase: 8 decimals  
  // - currentLiquidationThreshold: 4 decimals (basis points)
  // - We need result in 8 decimals (USD base)
  //
  // Formula: minCollateral = (minHealthFactor * totalDebtBase) / (currentLiquidationThreshold * 10^14)
  // This accounts for: 18 dec + 8 dec - 4 dec - 18 dec = 4 dec adjustment needed
  // Actually: we need to divide by 10^14 to normalize from 18+8-4=22 decimals to 8 decimals
  
  const SCALE_FACTOR = 10n ** 14n // Adjust from 22 decimals (18+8-4) to 8 decimals
  
  // Avoid division by zero
  if (position.currentLiquidationThreshold === 0n) {
    return 0n
  }

  const minCollateralNeeded =
    (minHealthFactor * position.totalDebtBase) / (position.currentLiquidationThreshold * SCALE_FACTOR)
  
  const maxWithdrawable = position.totalCollateralBase > minCollateralNeeded
    ? position.totalCollateralBase - minCollateralNeeded
    : 0n

  return maxWithdrawable
}

/**
 * Cross-chain rebalance Aave positions by:
 * 1. Checking health factors across all chains
 * 2. Identifying positions needing collateral (bad health factor)
 * 3. Withdrawing collateral from positions with better health factors
 * 4. Creating voucher requests to transfer collateral to chains that need it
 * 5. Using vouchers on destination chains
 * 6. Supplying collateral on chains that need it
 */
export async function crossChainRebalanceAavePositions(
  sdk: CrossChainSdk,
  account: IMultiChainSmartAccount,
  positions: AavePosition[],
  collateralToken: MultichainToken,
  callback: ExecCallback,
  healthFactorThreshold: bigint = parseUnits('1.5', 18),
  targetHealthFactor: bigint = parseUnits('2.0', 18)
): Promise<void> {
  // Separate positions into unhealthy (need collateral) and healthy (can provide collateral)
  const unhealthyPositions = positions.filter((pos) =>
    isPositionUnhealthy(pos, healthFactorThreshold)
  )
  const healthyPositions = positions.filter((pos) =>
    !isPositionUnhealthy(pos, healthFactorThreshold) && pos.totalCollateralBase > 0n
  )

  if (unhealthyPositions.length === 0) {
    throw new Error('No unhealthy positions to rebalance')
  }

  if (healthyPositions.length === 0) {
    throw new Error('No healthy positions to provide collateral')
  }

  // Calculate collateral needed for each unhealthy position
  const collateralNeededByChain = new Map<number, bigint>()
  for (const position of unhealthyPositions) {
    const needed = calculateCollateralNeeded(position, targetHealthFactor)
    const current = collateralNeededByChain.get(position.chainId) || 0n
    collateralNeededByChain.set(position.chainId, current + needed)
  }

  // Calculate how much can be withdrawn from each healthy position
  const withdrawableByChain = new Map<number, bigint>()
  for (const position of healthyPositions) {
    const withdrawable = calculateMaxWithdrawable(position, healthFactorThreshold)
    console.log(`[DEBUG] Chain ${position.chainId}:`, {
      totalCollateralBase: position.totalCollateralBase.toString(),
      totalDebtBase: position.totalDebtBase.toString(),
      healthFactor: position.healthFactor.toString(),
      currentLiquidationThreshold: position.currentLiquidationThreshold.toString(),
      withdrawable: withdrawable.toString(),
    })
    const current = withdrawableByChain.get(position.chainId) || 0n
    withdrawableByChain.set(position.chainId, current + withdrawable)
  }
  
  console.log(`[DEBUG] withdrawableByChain:`, Array.from(withdrawableByChain.entries()).map(([chainId, amount]) => ({
    chainId,
    amount: amount.toString(),
  })))

  // Calculate total collateral needed and available
  const totalNeeded = Array.from(collateralNeededByChain.values()).reduce(
    (sum, amount) => sum + amount,
    0n
  )
  const totalAvailable = Array.from(withdrawableByChain.values()).reduce(
    (sum, amount) => sum + amount,
    0n
  )

  if (totalAvailable < totalNeeded) {
    console.warn(
      `Not enough collateral available. Needed: ${totalNeeded}, Available: ${totalAvailable}`
    )
  }

  const builder = sdk.createBuilder()

  // Step 1: Withdraw collateral from healthy positions and create voucher requests
  const voucherRequests: Array<{
    sourceChainId: number
    destinationChainId: number
    amount: bigint
  }> = []

  // Distribute available collateral to chains that need it
  const remainingNeeded = new Map(collateralNeededByChain)
  const remainingAvailable = new Map(withdrawableByChain)

  for (const [sourceChainId, available] of remainingAvailable.entries()) {
    if (available === 0n) continue

    // Find chains that need collateral
    for (const [destChainId, needed] of remainingNeeded.entries()) {
      if (needed === 0n || sourceChainId === destChainId) continue

      const transferAmount = available < needed ? available : needed
      if (transferAmount > 0n) {
        voucherRequests.push({
          sourceChainId,
          destinationChainId: destChainId,
          amount: transferAmount,
        })

        remainingNeeded.set(destChainId, needed - transferAmount)
        remainingAvailable.set(sourceChainId, available - transferAmount)

        if (remainingAvailable.get(sourceChainId) === 0n) break
      }
    }
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

  // Create batches for withdrawing collateral and requesting vouchers
  for (const [sourceChainId, withdrawAmount] of withdrawalsByChain.entries()) {
    const position = healthyPositions.find((p) => p.chainId === sourceChainId)
    if (!position) continue

    const poolAddress = getAavePoolAddress(sourceChainId)
    const collateralTokenAddress = collateralToken.addressOn(BigInt(sourceChainId))
    if (!poolAddress || !collateralTokenAddress) continue

    const batch = builder.startBatch(BigInt(sourceChainId))
    const userAddress = position.userAddress

    // Withdraw collateral from Aave
    batch.addAction(
      new FunctionCallAction({
        target: poolAddress as Address,
        functionName: 'withdraw',
        args: [collateralTokenAddress, withdrawAmount, userAddress],
        abi: AAVE_POOL_ABI,
        value: 0n,
      })
    )

    // Create voucher requests for each destination chain
    const vouchers = vouchersBySourceChain.get(sourceChainId) || []
    for (let i = 0; i < vouchers.length; i++) {
      const voucher = vouchers[i]
      batch.addVoucherRequest({
        ref: `voucher_${sourceChainId}_to_${voucher.destChainId}`,
        destinationChainId: BigInt(voucher.destChainId),
        tokens: [{ token: collateralToken, amount: voucher.amount }],
      })
    }

    batch.overrideUserOp(useropOverride).endBatch()
  }

  // Step 2: Use vouchers and supply collateral on destination chains
  const suppliesByChain = new Map<number, bigint>()
  for (const voucher of voucherRequests) {
    const current = suppliesByChain.get(voucher.destinationChainId) || 0n
    suppliesByChain.set(voucher.destinationChainId, current + voucher.amount)
  }

  for (const [destChainId, supplyAmount] of suppliesByChain.entries()) {
    const position = unhealthyPositions.find((p) => p.chainId === destChainId)
    if (!position) continue

    const poolAddress = getAavePoolAddress(destChainId)
    const collateralTokenAddress = collateralToken.addressOn(BigInt(destChainId))
    if (!poolAddress || !collateralTokenAddress) continue

    const batch = builder.startBatch(BigInt(destChainId))
    const userAddress = position.userAddress

    // Use all vouchers received on this chain
    batch.useAllVouchers()

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

    batch.overrideUserOp(useropOverride).endBatch()
  }

  builder.useAccount(account)
  const executor = await builder.buildAndSign()
  await executor.execute(callback)
}

