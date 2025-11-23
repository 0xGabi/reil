import { getAccount, getWalletClient, reconnect } from '@wagmi/core'
import { type WalletClient, zeroAddress } from 'viem'
import { type Address } from 'viem'

import {
  AmbireBundlerManager,
  CrossChainSdk,
  type IMultiChainSmartAccount,
} from '@eil-protocol/sdk'

import { AmbireMultiChainSmartAccount } from '@eil-protocol/accounts'

import { getDeploymentChains, wagmiConfig } from '../wagmiConfig.ts'



/**
 *  A helper function to fetch and build the {@link WalletClient} for the current connected wallet.
 *  As the injected wallet may take time to connect, this function waits and polls for readiness.
 *  It retries until successful or until the maximum attempts are reached.
 */
async function fetchWalletClient (): Promise<WalletClient | undefined> {
    // Ensure reconnection is triggered
    await reconnect(wagmiConfig)
    // Poll for connector readiness
    const maxAttempts = 5
    const delay = 1000 // 1 second
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const account = getAccount(wagmiConfig)
      if (account.isConnected && account.connector && typeof account.connector.getChainId === 'function') {
        try {
          const walletClient = await getWalletClient(wagmiConfig, {
            connector: account.connector,
          })
          console.log('Wallet client:', walletClient)
          return walletClient
        } catch (error) {
          console.error('Failed to get wallet client:', error)
          throw error
        }
      }
      if (attempt === maxAttempts) {
        throw new Error('Connector not ready after maximum attempts')
      }
      console.log(`Attempt ${attempt}: Connector not ready, retrying in ${delay}ms...`)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
    return undefined
  }

/**
 * A helper function to create an instance of the EIL SDK with the configured chains and account.
 * In this case we are only creating the {@link AmbireMultiChainSmartAccount}.
 *
 * However, the SDK works with any valid implementation of the {@link IMultiChainSmartAccount} interface.
 */
export async function createEilSdk (): Promise<{ sdk: CrossChainSdk, account: AmbireMultiChainSmartAccount }> {
    const [chainId0, chainId1, chainId2, chainId3] = getDeploymentChains()
  
    const walletClient: WalletClient | undefined = await fetchWalletClient()
    if (walletClient == null) {
      throw new Error('Wallet client is null')
    }
    const ambireBundlerManager = new AmbireBundlerManager(walletClient, new Map<bigint, Address>())
    const walletAccount = getAccount(wagmiConfig)?.address ?? zeroAddress
    const ambireAccount = new AmbireMultiChainSmartAccount(
      walletClient,
      walletAccount,
      [BigInt(chainId0), BigInt(chainId1), BigInt(chainId2), BigInt(chainId3)],
      ambireBundlerManager
    )
    await ambireAccount.init()
  
    const crossChainSdk = new CrossChainSdk()
    return { sdk: crossChainSdk, account: ambireAccount }
  }