import { type Address } from 'viem'

/**
 * Aave Oracle addresses per chain
 */
export const AAVE_ORACLE_ADDRESSES: Record<number, Address> = {
  1: '0x54586bE62E3c3580375aE3723C145253060Ca0C2', // Mainnet
  42161: '0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7', // Arbitrum
  8453: '0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156', // Base
  10: '0xD81eb3728a631871a7eBBaD631b5f424909f0c77', // Optimism
}

/**
 * Aave Oracle ABI (minimal - just getAssetPrice)
 */
export const AAVE_ORACLE_ABI = [
  {
    inputs: [{ internalType: 'address', name: 'asset', type: 'address' }],
    name: 'getAssetPrice',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

/**
 * UserOperation override for gas settings
 */
export const USEROP_OVERRIDE = {
  maxFeePerGas: 1000000000n,
  maxPriorityFeePerGas: 10n,
} as const

