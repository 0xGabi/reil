import { network } from 'hardhat'
import { Address, type PublicClient, type WalletClient } from 'viem'
import { AAVE_POOL_ADDRESSES, USDC_ADDRESSES } from './constants.js'

/**
 * Get network clients using Hardhat's viem helpers
 * Returns both public and wallet clients, plus the account address
 */
export async function getNetworkClients(): Promise<{
  publicClient: PublicClient
  walletClient: WalletClient
  accountAddress: Address
  chainId: number
}> {
  // Connect to network and get viem helpers
  const { viem } = await network.connect()
  
  // Get public client using Hardhat's viem helpers
  const publicClient = await viem.getPublicClient()
  
  // Get chain configuration
  const chain = publicClient.chain
  const chainId = chain?.id
  
  if (!chainId) {
    throw new Error('Could not determine chain ID from network')
  }

  // Use first available wallet client from Hardhat
  const walletClients = await viem.getWalletClients()
  if (walletClients.length === 0) {
    throw new Error('No wallet clients available. Please configure accounts in Hardhat.')
  }
  
  const walletClient = walletClients[0]
  
  // Get account address from wallet client
  if (!walletClient.account) {
    throw new Error('Wallet client does not have an account configured')
  }
  
  const accountAddress = walletClient.account.address

  return {
    publicClient,
    walletClient,
    accountAddress,
    chainId,
  }
}

/**
 * Get Aave pool address for a given chain ID
 */
export function getAavePoolAddress(chainId: number): Address {
  const address = AAVE_POOL_ADDRESSES[chainId]
  if (!address) {
    throw new Error(`Aave pool address not found for chain ${chainId}`)
  }
  return address
}

/**
 * Get USDC token address for a given chain ID
 */
export function getUsdcAddress(chainId: number): Address {
  const address = USDC_ADDRESSES[chainId]
  if (!address) {
    throw new Error(`USDC token address not found for chain ${chainId}`)
  }
  return address
}


/**
 * Verify chain ID matches expected value
 */
export function verifyChainId(actualChainId: number, expectedChainId: number): void {
  if (actualChainId !== expectedChainId) {
    throw new Error(
      `Network chain ID (${actualChainId}) does not match expected chain ID (${expectedChainId}). ` +
      `Use --network flag to select the correct network.`
    )
  }
}

