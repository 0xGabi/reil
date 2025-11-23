// Types
export type { AavePosition, AaveReserveData } from './types.ts'

// Position fetching
export { fetchAavePosition, fetchAavePositions } from './position.ts'

// Health factor calculations
export {
  isPositionUnhealthy,
  calculateRepayAmount,
  calculateCollateralNeeded,
  calculateMaxWithdrawable,
} from './healthFactor.ts'

// Rebalancing functions
export {
  rebalanceAavePositions,
  crossChainRebalanceAavePositions,
} from './rebalance.ts'

// Utilities (exported for advanced use cases)
export {
  getATokenBalance,
  getTokenPrice,
  convertUSDBaseToTokenAmount,
} from './utils.ts'

// Constants (exported for advanced use cases)
export {
  AAVE_ORACLE_ADDRESSES,
  AAVE_ORACLE_ABI,
  USEROP_OVERRIDE,
} from './constants.ts'

// Optimization (exported for advanced use cases)
export { optimizeRebalanceDistribution } from './optimization.ts'

// EIL
export { createEilSdk } from './eil.ts'

