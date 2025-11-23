import { type Address } from 'viem'

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

