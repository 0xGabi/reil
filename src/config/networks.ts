/**
 * Network Configuration
 * 
 * Configure which networks your app should use here.
 * Simply modify the CHAIN_IDS array to add, remove, or reorder networks.
 */

// Supported chain IDs
export const CHAIN_IDS = [1, 10, 42161, 8453] as const

// Chain ID to name mapping
export const CHAIN_NAMES: Record<number, string> = {
  1: 'Ethereum',
  10: 'Optimism',
  42161: 'Arbitrum',
  8453: 'Base',
  11155111: 'Sepolia',
  421614: 'Arbitrum Sepolia',
  84532: 'Base Sepolia',
  11155420: 'Optimism Sepolia',
}

// Chain ID to color mapping (for UI)
export const CHAIN_COLORS: Record<number, string> = {
  1: '#627EEA',      // Ethereum blue
  10: '#FF0420',      // Optimism red
  42161: '#28A0F0',   // Arbitrum blue
  8453: '#0052FF',    // Base blue
  11155111: '#627EEA',
  421614: '#28A0F0',
  84532: '#0052FF',
  11155420: '#FF0420',
}

/**
 * Get the configured chain IDs as an array
 */
export function getDeploymentChains(): number[] {
  return [...CHAIN_IDS]
}

/**
 * Get chain name by chain ID
 */
export function getChainName(chainId: number): string {
  return CHAIN_NAMES[chainId] || `Chain ${chainId}`
}

/**
 * Get chain color by chain ID
 */
export function getChainColor(chainId: number): string {
  return CHAIN_COLORS[chainId] || '#666'
}

