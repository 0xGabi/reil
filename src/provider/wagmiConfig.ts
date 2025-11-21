import { WagmiAdapter } from '@reown/appkit-adapter-wagmi'
import { createAppKit } from '@reown/appkit/react'
import { type AppKitNetwork, arbitrum, base, mainnet, optimism, sepolia, arbitrumSepolia, optimismSepolia, baseSepolia } from '@reown/appkit/networks'
import { http } from 'viem'

import { getMultiChainConfig } from '@eil-protocol/sdk'

import FlagsDeployment from '../../deployment/flags.json'

const projectId = 'a3c307b5f67aec880eea6812706d67c7'

/**
 * Helper function to get chain deployment by chain ID.
 */
export function getDeploymentChains (): [number, number] {
  return [FlagsDeployment[0].chainId, FlagsDeployment[1].chainId]
}

// Helper function to map chain ID to AppKit network
function getAppKitNetworkByChainId(chainId: number): AppKitNetwork {
  switch (chainId) {
    case 1: return mainnet
    case 10: return optimism
    case 8453: return base
    case 42161: return arbitrum
    case 11155111: return sepolia
    case 421614: return arbitrumSepolia
    case 84532: return baseSepolia
    case 11155420: return optimismSepolia
    default:
      throw new Error(`Unsupported chain ID: ${chainId}`)
  }
}

// Get the deployment info for both chains
const [chainId0, chainId1] = getDeploymentChains()

// Get the corresponding AppKit networks
const network0 = getAppKitNetworkByChainId(chainId0)
const network1 = getAppKitNetworkByChainId(chainId1)

// Create the networks array with all supported networks but prioritize the deployment chains
const appNetworks: [AppKitNetwork, ...AppKitNetwork[]] = [
  network0,
  network1,
  // Include other common networks
  ...[mainnet, base, arbitrum, optimism, sepolia, arbitrumSepolia, baseSepolia, optimismSepolia]
    .filter(net => net.id !== network0.id && net.id !== network1.id)
] as [AppKitNetwork, ...AppKitNetwork[]]

// Build transports dynamically
const transports: Record<number, ReturnType<typeof http>> = {}

const chainConfig = getMultiChainConfig()
console.log('chainConfig:', chainConfig)
const net1 = chainConfig.find(c=> Number(c.chainId) === chainId0)!
const net2 = chainConfig.find(c=> Number(c.chainId) === chainId1)!
transports[Number(net1.chainId)] = http(net1.publicClient.transport.url)
transports[Number(net2.chainId)] = http(net2.publicClient.transport.url)

// Add default transports for other common networks
const defaultNetworks = [mainnet, arbitrum, base, optimism, sepolia, arbitrumSepolia, baseSepolia, optimismSepolia]
defaultNetworks.forEach(network => {
  if (!transports[network.id]) {
    transports[network.id] = http()
  }
})

export const wagmiAdapter = new WagmiAdapter({
  networks: appNetworks,
  transports,
  projectId,
  ssr: false,
  batch: { multicall: true },
})

createAppKit({
  adapters: [wagmiAdapter],
  networks: appNetworks,
  projectId,
  enableWalletConnect: true,
  defaultNetwork: sepolia,
  debug: import.meta.env.VITE_IS_PRODUCTION === 'false',
  featuredWalletIds: [
    'c57ca95b47569778a828d19178114f4db188b89b763c899ba0be274e97267d96', // metamask
  ],
  features: {
    swaps: false,
    onramp: false,
    email: false,
    socials: false,
    analytics: false,
  },
})

export const wagmiConfig = wagmiAdapter.wagmiConfig
