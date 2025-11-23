import { parseUnits } from 'viem'
import { type AavePosition } from './types.ts'

/**
 * Check if a position is unhealthy (health factor below threshold)
 */
export function isPositionUnhealthy(
  position: AavePosition,
  threshold: bigint = parseUnits('1.2', 18)
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

  // Health factor formula: HF = (collateral * liquidationThreshold * 10^14) / debt
  // Where:
  // - collateral (totalCollateralBase): 8 decimals
  // - liquidationThreshold: 4 decimals (e.g., 8500 = 85% = 0.85)
  // - debt (totalDebtBase): 8 decimals
  // - healthFactor: 18 decimals
  // The 10^14 scaling comes from: 18 - 8 + 4 = 14
  //
  // Target: (collateral * liquidationThreshold * 10^14) / (debt - repayAmount) = targetHealthFactor
  // Solving for repayAmount:
  // repayAmount = debt - (collateral * liquidationThreshold * 10^14) / targetHealthFactor
  // Scale liquidationThreshold to 18 decimals to match healthFactor
  const liquidationThresholdScaled = position.currentLiquidationThreshold * 10n ** 14n
  
  const numerator = position.totalCollateralBase * liquidationThresholdScaled
  const targetDebt = numerator / targetHealthFactor
  const repayAmount = position.totalDebtBase - targetDebt

  return repayAmount > 0n ? repayAmount : 0n
}

/**
 * Calculate the collateral amount needed to improve health factor to target
 * 
 * Returns amount in USD base (8 decimals), representing USD value needed.
 * This works correctly for any collateral token type (USDC, WETH, etc.) because:
 * - All values (totalCollateralBase, totalDebtBase) are already in USD terms
 * - The calculation is token-agnostic and works with USD values
 * - The result can be converted to token amounts using the token's price
 */
export function calculateCollateralNeeded(
  position: AavePosition,
  targetHealthFactor: bigint = parseUnits('1.2', 18)
): bigint {
  if (position.totalDebtBase === 0n || position.healthFactor === 0n) {
    return 0n
  }
  const liquidationThresholdScaled = position.currentLiquidationThreshold * 10n ** 14n
  
  // To find target collateral for a given health factor:
  // targetCollateral = (targetHealthFactor * debt) / (liquidationThreshold * 10^14)
  // Scale liquidationThreshold to 18 decimals to match healthFactor
  const targetCollateral =
    (targetHealthFactor * position.totalDebtBase) / liquidationThresholdScaled
  const additionalCollateral = targetCollateral > position.totalCollateralBase
    ? targetCollateral - position.totalCollateralBase
    : 0n

  return additionalCollateral
}

/**
 * Calculate the maximum amount that can be withdrawn from a position without making it unhealthy
 * 
 */
export function calculateMaxWithdrawable(
  position: AavePosition,
  minHealthFactor: bigint = parseUnits('1.2', 18)
): bigint {
  if (position.totalDebtBase === 0n || position.healthFactor === 0n) {
    return position.totalCollateralBase / 2n // Withdraw at most 50% if no debt
  }

  const liquidationThresholdScaled = position.currentLiquidationThreshold * 10n ** 14n

  // To find minimum collateral needed for a given health factor:
  // minCollateral = (minHealthFactor * debt) / (liquidationThreshold * 10^14)
  // Scale liquidationThreshold to 18 decimals to match healthFactor
  const minCollateralNeeded =
    (minHealthFactor * position.totalDebtBase) / liquidationThresholdScaled
  
  const maxWithdrawable = position.totalCollateralBase > minCollateralNeeded
    ? position.totalCollateralBase - minCollateralNeeded
    : 0n

  return maxWithdrawable
}

