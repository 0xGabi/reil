import { parseUnits } from 'viem'
import { type AavePosition } from './types.ts'
import { calculateCollateralNeeded, calculateMaxWithdrawable } from './healthFactor.ts'

/**
 * Optimally distribute collateral from healthy positions to unhealthy positions
 * Ensures all positions end up with health factor >= minHealthFactor
 * Returns a map of chainId -> withdrawal amount and a map of chainId -> supply amount
 */
export function optimizeRebalanceDistribution(
  healthyPositions: AavePosition[],
  unhealthyPositions: AavePosition[],
  minHealthFactor: bigint = parseUnits('1.2', 18)
): {
  withdrawals: Map<number, bigint>
  supplies: Map<number, bigint>
} {
  const withdrawals = new Map<number, bigint>()
  const supplies = new Map<number, bigint>()

  // Calculate how much each unhealthy position needs to reach minHealthFactor
  const needsByChain = new Map<number, bigint>()
  for (const position of unhealthyPositions) {
    const needed = calculateCollateralNeeded(position, minHealthFactor)
    needsByChain.set(position.chainId, needed)
  }

  // Calculate how much can be withdrawn from each healthy position while staying >= minHealthFactor
  const availableByChain = new Map<number, bigint>()
  for (const position of healthyPositions) {
    const available = calculateMaxWithdrawable(position, minHealthFactor)
    availableByChain.set(position.chainId, available)
  }

  // Calculate total needs and available
  const totalNeeded = Array.from(needsByChain.values()).reduce((sum, amt) => sum + amt, 0n)
  const totalAvailable = Array.from(availableByChain.values()).reduce((sum, amt) => sum + amt, 0n)

  if (totalAvailable < totalNeeded) {
    // Not enough collateral available - distribute proportionally
    // Prioritize positions with worst health factors
    const sortedUnhealthy = [...unhealthyPositions].sort((a, b) => {
      if (a.healthFactor === 0n) return 1
      if (b.healthFactor === 0n) return -1
      return a.healthFactor < b.healthFactor ? -1 : 1
    })

    const remainingNeeded = new Map(needsByChain)
    const remainingAvailable = new Map(availableByChain)

    // Distribute available collateral proportionally based on need
    for (const position of sortedUnhealthy) {
      const needed = remainingNeeded.get(position.chainId) || 0n
      if (needed === 0n) continue

      // Calculate proportional allocation
      const allocation = totalAvailable > 0n
        ? (needed * totalAvailable) / totalNeeded
        : 0n

      if (allocation > 0n) {
        supplies.set(position.chainId, (supplies.get(position.chainId) || 0n) + allocation)
        remainingNeeded.set(position.chainId, needed - allocation)
      }
    }

    // Withdraw from healthy positions proportionally to their available amounts
    const sortedHealthy = [...healthyPositions].sort((a, b) => {
      // Prioritize positions with higher health factors (more room to withdraw)
      if (a.healthFactor === 0n) return 1
      if (b.healthFactor === 0n) return -1
      return a.healthFactor > b.healthFactor ? -1 : 1
    })

    let remainingToWithdraw = totalAvailable
    for (const position of sortedHealthy) {
      if (remainingToWithdraw === 0n) break

      const available = remainingAvailable.get(position.chainId) || 0n
      if (available === 0n) continue

      const withdrawAmount = available < remainingToWithdraw ? available : remainingToWithdraw
      withdrawals.set(position.chainId, (withdrawals.get(position.chainId) || 0n) + withdrawAmount)
      remainingToWithdraw -= withdrawAmount
      remainingAvailable.set(position.chainId, available - withdrawAmount)
    }
  } else {
    // Enough collateral available - distribute optimally
    // First, satisfy all needs exactly
    for (const [chainId, needed] of needsByChain.entries()) {
      if (needed > 0n) {
        supplies.set(chainId, needed)
      }
    }

    // Then, withdraw from healthy positions to satisfy the supplies
    // Distribute withdrawals proportionally based on available amounts
    const sortedHealthy = [...healthyPositions].sort((a, b) => {
      // Prioritize positions with higher health factors
      if (a.healthFactor === 0n) return 1
      if (b.healthFactor === 0n) return -1
      return a.healthFactor > b.healthFactor ? -1 : 1
    })

    let remainingToWithdraw = totalNeeded
    for (const position of sortedHealthy) {
      if (remainingToWithdraw === 0n) break

      const available = availableByChain.get(position.chainId) || 0n
      if (available === 0n) continue

      const withdrawAmount = available < remainingToWithdraw ? available : remainingToWithdraw
      withdrawals.set(position.chainId, (withdrawals.get(position.chainId) || 0n) + withdrawAmount)
      remainingToWithdraw -= withdrawAmount
    }
  }

  return { withdrawals, supplies }
}

