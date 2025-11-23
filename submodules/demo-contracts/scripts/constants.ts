import { Address } from 'viem'

/**
 * Aave Pool addresses per chain
 */
export const AAVE_POOL_ADDRESSES: Record<number, Address> = {
  1: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', // Mainnet
  11155111: '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951', // Sepolia
  42161: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', // Arbitrum
  8453: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5', // Base
  10: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', // Optimism
}

/**
 * USDC token addresses per chain
 */
export const USDC_ADDRESSES: Record<number, Address> = {
  1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // Mainnet
  10: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', // Optimism
  42161: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // Arbitrum
  8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base
  11155111: '0x1c7D4B196Cb0C7B01d743Fbc6116a902391C1510', // Sepolia
  421614: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d', // Arbitrum Sepolia
  84532: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Base Sepolia
  11155420: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7', // Optimism Sepolia
}

/**
 * WETH token addresses per chain
 */
export const WETH_ADDRESSES: Record<number, Address> = {
  1: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // Mainnet
  10: '0x4200000000000000000000000000000000000006', // Optimism
  42161: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // Arbitrum
  8453: '0x4200000000000000000000000000000000000006', // Base
  11155111: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', // Sepolia
  421614: '0x980B62Da83eFf3D4576C647993b0c1D7faf17c73', // Arbitrum Sepolia
  84532: '0x4200000000000000000000000000000000000006', // Base Sepolia
  11155420: '0x4200000000000000000000000000000000000006', // Optimism Sepolia
}

/**
 * Token symbol to address mapping
 */
export const TOKEN_ADDRESSES: Record<string, Record<number, Address>> = {
  USDC: USDC_ADDRESSES,
  WETH: WETH_ADDRESSES,
}

/**
 * Aave Pool ABI (minimal needed functions)
 */
export const AAVE_POOL_ABI = [
  {
    inputs: [
      { internalType: 'address', name: 'asset', type: 'address' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' },
      { internalType: 'address', name: 'onBehalfOf', type: 'address' },
      { internalType: 'uint16', name: 'referralCode', type: 'uint16' },
    ],
    name: 'supply',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'asset', type: 'address' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' },
      { internalType: 'uint256', name: 'interestRateMode', type: 'uint256' },
      { internalType: 'uint16', name: 'referralCode', type: 'uint16' },
      { internalType: 'address', name: 'onBehalfOf', type: 'address' },
    ],
    name: 'borrow',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'asset', type: 'address' },
      { internalType: 'bool', name: 'useAsCollateral', type: 'bool' },
    ],
    name: 'setUserUseReserveAsCollateral',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'asset', type: 'address' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' },
      { internalType: 'address', name: 'to', type: 'address' },
    ],
    name: 'withdraw',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'address', name: 'asset', type: 'address' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' },
      { internalType: 'uint256', name: 'interestRateMode', type: 'uint256' },
      { internalType: 'address', name: 'onBehalfOf', type: 'address' },
    ],
    name: 'repay',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'user', type: 'address' }],
    name: 'getUserAccountData',
    outputs: [
      { internalType: 'uint256', name: 'totalCollateralBase', type: 'uint256' },
      { internalType: 'uint256', name: 'totalDebtBase', type: 'uint256' },
      { internalType: 'uint256', name: 'availableBorrowsBase', type: 'uint256' },
      { internalType: 'uint256', name: 'currentLiquidationThreshold', type: 'uint256' },
      { internalType: 'uint256', name: 'ltv', type: 'uint256' },
      { internalType: 'uint256', name: 'healthFactor', type: 'uint256' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'address', name: 'asset', type: 'address' }],
    name: 'getReserveData',
    outputs: [
      {
        components: [
          {
            components: [{ internalType: 'uint256', name: 'data', type: 'uint256' }],
            internalType: 'struct DataTypes.ReserveConfigurationMap',
            name: 'configuration',
            type: 'tuple',
          },
          { internalType: 'uint128', name: 'liquidityIndex', type: 'uint128' },
          { internalType: 'uint128', name: 'currentLiquidityRate', type: 'uint128' },
          { internalType: 'uint128', name: 'variableBorrowIndex', type: 'uint128' },
          { internalType: 'uint128', name: 'currentVariableBorrowRate', type: 'uint128' },
          { internalType: 'uint128', name: 'currentStableBorrowRate', type: 'uint128' },
          { internalType: 'uint40', name: 'lastUpdateTimestamp', type: 'uint40' },
          { internalType: 'uint16', name: 'id', type: 'uint16' },
          { internalType: 'address', name: 'aTokenAddress', type: 'address' },
          { internalType: 'address', name: 'stableDebtTokenAddress', type: 'address' },
          { internalType: 'address', name: 'variableDebtTokenAddress', type: 'address' },
          { internalType: 'address', name: 'interestRateStrategyAddress', type: 'address' },
          { internalType: 'uint128', name: 'accruedToTreasury', type: 'uint128' },
          { internalType: 'uint128', name: 'unbacked', type: 'uint128' },
          { internalType: 'uint128', name: 'isolationModeTotalDebt', type: 'uint128' },
        ],
        internalType: 'struct DataTypes.ReserveData',
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const

/**
 * Aave Protocol Data Provider ABI (for getting reserve data)
 */
export const AAVE_PROTOCOL_DATA_PROVIDER_ABI = [
  {
    inputs: [
      { internalType: 'address', name: 'asset', type: 'address' },
      { internalType: 'address', name: 'user', type: 'address' },
    ],
    name: 'getUserReserveData',
    outputs: [
      { internalType: 'uint256', name: 'currentATokenBalance', type: 'uint256' },
      { internalType: 'uint256', name: 'currentStableDebt', type: 'uint256' },
      { internalType: 'uint256', name: 'currentVariableDebt', type: 'uint256' },
      { internalType: 'uint256', name: 'principalStableDebt', type: 'uint256' },
      { internalType: 'uint256', name: 'scaledVariableDebt', type: 'uint256' },
      { internalType: 'uint256', name: 'stableBorrowRate', type: 'uint256' },
      { internalType: 'uint256', name: 'liquidityRate', type: 'uint256' },
      { internalType: 'uint40', name: 'stableRateLastUpdated', type: 'uint40' },
      { internalType: 'bool', name: 'usageAsCollateralEnabled', type: 'bool' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const

/**
 * Test token mint ABI (for test tokens)
 */
export const TEST_TOKEN_MINT_ABI = [
  {
    inputs: [
      { internalType: 'address', name: 'to', type: 'address' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' },
    ],
    name: 'mint',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

/**
 * WETH ABI (for wrapping/unwrapping ETH)
 */
export const WETH_ABI = [
  {
    name: 'deposit',
    type: 'function',
    stateMutability: 'payable',
    inputs: [],
    outputs: [],
  },
  {
    name: 'withdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'wad', type: 'uint256' }],
    outputs: [],
  },
] as const

