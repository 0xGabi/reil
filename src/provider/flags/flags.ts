import { getClient, getPublicClient } from 'wagmi/actions'
import { getAccount, getWalletClient, reconnect } from '@wagmi/core'
import { getBalance, readContract } from 'viem/actions'
import { type PublicClient, type WalletClient, zeroAddress } from 'viem'
import { type Address, erc20Abi, formatEther, parseUnits, toHex } from 'viem'
import type { SmartAccount } from 'viem/account-abstraction'

import {
  AmbireBundlerManager,
  CrossChainSdk,
  FunctionCallAction,
  MultichainToken,
  SetVarAction,
  debugSetTokenAmount,
  runtimeVar,
  type ExecCallback,
  type IMultiChainSmartAccount,
} from '@eil-protocol/sdk'

import { AmbireMultiChainSmartAccount } from '@eil-protocol/accounts'

import { getDeploymentChains, wagmiConfig } from '../wagmiConfig.ts'
import { BALANCE_PLACEHOLDER } from '../../utils/constants.ts'
import {
  abi
} from '../../../submodules/demo-contracts/artifacts/contracts/CaptureTheFlag2.sol/CaptureTheFlag2.json'

import FlagsDeployment from '../../../deployment/flags.json'

export interface CapturedFlagsData {
  flagHolder0: string
  flagHolder1: string
}

export interface BalanceData {
  balance0: bigint
  balance1: bigint
  balanceEth0: bigint
  balanceEth1: bigint
}

/**
 * Helper function to get chain deployment by chain ID.
 */
function getFlagsDeploymentByChain (chainId: number): { chainId: number, captureTheFlag: string } {
  const deployment = FlagsDeployment.find(d => d.chainId === chainId)
  if (!deployment) {
    throw new Error(`Flags deployment not found for chain ${chainId}`)
  }
  return deployment
}


  const useropOverride = {
    maxFeePerGas: 1000000000n,
    maxPriorityFeePerGas: 10n
  }

/**
 * A simple helper function to fetch the captured flags data from the deployed contracts.
 * @param chainIds
 */
export async function fetchCapturedFlags (chainIds: number[]): Promise<CapturedFlagsData> {
  const client0 = getClient(wagmiConfig, { chainId: chainIds[0] })
  const client1 = getClient(wagmiConfig, { chainId: chainIds[1] })

  if (client0 == null || client1 == null) {
    throw new Error('Clients not initialized')
  }

  console.log('chainIds', chainIds)

  const deployment0 = getFlagsDeploymentByChain(chainIds[0])
  const deployment1 = getFlagsDeploymentByChain(chainIds[1])

  console.log('Deployments: ', deployment0.captureTheFlag, deployment1.captureTheFlag)

  const flagHolder0 = await readContract(client0, {
    abi,
    address: deployment0.captureTheFlag as Address,
    functionName: 'flagHolder',
  }) as string

  const flagHolder1 = await readContract(client1, {
    abi,
    address: deployment1.captureTheFlag as Address,
    functionName: 'flagHolder',
  }) as string

  return {
    flagHolder0,
    flagHolder1
  }
}

/**
 * A simple helper function to fetch the multi-chain token balances of the multi-chain account on the two chains.
 *
 * @param chainIds - the chain IDs of the two chains to fetch balances for
 * @param token - the instance of the {@link MultichainToken} to fetch balances for
 * @param account - the instance of the {@link IMultiChainSmartAccount} to fetch balances for
 */
export async function fetchTokenBalances (
  chainIds: number[],
  token: MultichainToken,
  account: IMultiChainSmartAccount | undefined
): Promise<BalanceData> {
  const client0 = getClient(wagmiConfig, { chainId: chainIds[0] })
  const client1 = getClient(wagmiConfig, { chainId: chainIds[1] })

  if (account == null) {
    console.error('Account is null 1')
    return BALANCE_PLACEHOLDER
  }

  const account0: SmartAccount = account.contractOn(BigInt(chainIds[0]))
  const account1: SmartAccount = account.contractOn(BigInt(chainIds[1]))

  console.log('fetchTokenBalances', chainIds, token, account0, account1)

  if (client0 == null || client1 == null) {
    throw new Error('Clients not initialized')
  }
  if (account0 == null || account1 == null) {
    return BALANCE_PLACEHOLDER
  }
  const address = token.addressOn(BigInt(chainIds[0]))
  console.log('querying balance of token', address, 'on chain', chainIds[0], 'for account', account0.address)
  const balance0 = await readContract(
    client0,
    {
      address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account0.address],
    }
  )

  const balance1 = await readContract(
    client1,
    {
      address: token.addressOn(BigInt(chainIds[1])),
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account1.address],
    }
  )

  const balanceEth0 = await getBalance(client0, { address: account0.address })
  const balanceEth1 = await getBalance(client1, { address: account1.address })

  console.log('balance0', balance0, 'balance1', balance1)

  return {
    balance0,
    balance1,
    balanceEth0,
    balanceEth1
  }
}

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
  const [chainId0, chainId1] = getDeploymentChains()

  const walletClient: WalletClient | undefined = await fetchWalletClient()
  if (walletClient == null) {
    throw new Error('Wallet client is null')
  }
  const ambireBundlerManager = new AmbireBundlerManager(walletClient, new Map<bigint, Address>())
  const walletAccount = getAccount(wagmiConfig)?.address ?? zeroAddress
  const ambireAccount = new AmbireMultiChainSmartAccount(walletClient, walletAccount, [BigInt(chainId0), BigInt(chainId1)], ambireBundlerManager)
  await ambireAccount.init()

  const crossChainSdk = new CrossChainSdk()
  return { sdk: crossChainSdk, account: ambireAccount }
}

/**
 *
 * This helper function uses the EIL SDK to perform two independent UserOperations on two chains.
 * There are no assets or data being moved across chains.
 * This demonstrates how EIL SDK improves the developer experience and abstracts away the complexity of a multi-chain UX.
 *
 * @param sdk - the instance of the EIL SDK
 * @param account - an instance of the IMultiChainSmartAccount used to perform the multi-chain UserOperations
 * @param name - the name of the flag capturer, demonstrating the passing of arbitrary data to the smart contract
 * @param callback - the callback function for the executor to update the UI on the progress of the UserOperations
 */
export async function captureFlags (sdk: CrossChainSdk, account: IMultiChainSmartAccount, name: string, callback: ExecCallback): Promise<void> {
  console.log(`capture flags button clicked: ${name}`)
  const [chainId0, chainId1] = getDeploymentChains()
  const deployment0 = getFlagsDeploymentByChain(chainId0)
  const deployment1 = getFlagsDeploymentByChain(chainId1)

  const executor = await sdk.createBuilder()
    .startBatch(BigInt(chainId0))
    .overrideUserOp(useropOverride)
    .addAction(new FunctionCallAction({
      target: deployment0.captureTheFlag as Address,
      functionName: 'captureFlag',
      args: [name],
      abi: abi,
      value: 0n
    }))
    .endBatch()
    .startBatch(BigInt(chainId1))
    .overrideUserOp(useropOverride)
    .addAction(new FunctionCallAction({
      target: deployment1.captureTheFlag as Address,
      functionName: 'captureFlag',
      args: [name],
      abi: abi,
      value: 0n
    }))
    .endBatch()
    .useAccount(account)
    .buildAndSign()
  await executor.execute(callback)
}

/**
 * This helper function uses the EIL SDK to perform two UserOperations on two chains with value transfer between chains.
 * It demonstrates the process of using the `VoucherRequest` to transfer funds between chains.
 */
export async function captureFlagsWithTransfer (
  sdk: CrossChainSdk,
  account: IMultiChainSmartAccount,
  name: string,
  usdc: MultichainToken,
  amount: bigint,
  callback: ExecCallback
): Promise<void> {
  console.log(`capture flags with transfer button clicked: ${name}, amount: ${amount}`)
  const [chainId0, chainId1] = getDeploymentChains()
  const deployment0 = getFlagsDeploymentByChain(chainId0)
  const deployment1 = getFlagsDeploymentByChain(chainId1)
  const executor = await sdk.createBuilder()
    .startBatch(BigInt(chainId0))
    .addVoucherRequest({
      ref: 'voucher_request_1',
      destinationChainId: BigInt(chainId1),
      tokens: [{ token: usdc,amount: amount }]
    })
    .addAction(new FunctionCallAction({
      target: deployment0.captureTheFlag as Address,
      functionName: 'captureFlag',
      args: [name],
      abi: abi,
      value: 0n
    }))
    .overrideUserOp(useropOverride)
    .endBatch()
    .startBatch(BigInt(chainId1))
    .useAllVouchers()
    .addAction(new FunctionCallAction({
      target: deployment1.captureTheFlag as Address,
      functionName: 'captureFlag',
      args: [name],
      abi: abi,
      value: 0n
    }))
    .overrideUserOp(useropOverride)
    .endBatch()
    .useAccount(account)
    .buildAndSign()
  await executor.execute(callback)
}

/**
 *
 * This helper function demonstrates the use of dynamic variables in the EIL SDK.
 * The variable called "blknum" will be created in the context of the multi-chain UserOperation.
 * It can be used interchangeably with a {@link BigInt} values in the SDK.
 * Here, the "blknum" value will be resolved on-chain with a call to a Solidity function called "getTheModBlockNumber".
 */
export async function captureFlagsWithTransferAndDynamicVariable (
  sdk: CrossChainSdk,
  name: string,
  usdc: MultichainToken,
  callback: ExecCallback
): Promise<void> {
  console.log(`capture flags with transfer button and dynamic variable clicked: ${name}`)
  const [chainId0, chainId1] = getDeploymentChains()
  const deployment0 = getFlagsDeploymentByChain(chainId0)
  const deployment1 = getFlagsDeploymentByChain(chainId1)

  const executor = await sdk.createBuilder()
    .startBatch(BigInt(chainId0))
    .addAction(new SetVarAction({
      target: deployment0.captureTheFlag as Address,
      functionName: 'getTheModBlockNumber',
      args: ['please'],
      abi: abi,
      setVar: 'blknum',
    }))
    .addVoucherRequest({
      ref: 'voucher_request_1',
      destinationChainId: BigInt(chainId1),
      tokens: [{
        token: usdc,
        amount: runtimeVar('blknum')
      }]
    })
    .addAction(new FunctionCallAction({
      target: deployment0.captureTheFlag as Address,
      functionName: 'captureFlag',
      args: [name],
      abi: abi,
      value: 0n
    }))
    .overrideUserOp(useropOverride)
    .endBatch()
    .startBatch(BigInt(chainId1))
    .useAllVouchers()
    .addAction(new FunctionCallAction({
      target: deployment1.captureTheFlag as Address,
      functionName: 'captureFlag',
      args: [name],
      abi: abi,
      value: 0n
    }))
    .overrideUserOp(useropOverride)
    .endBatch()
    .buildAndSign()
  await executor.execute(callback)
}

/**
 * A helper function to mint some tokens on a test chain.
 */
export async function sudoMint (chainId: number, token: MultichainToken, account: Address | undefined, callback: () => void): Promise<void> {
  if (account == null) {
    console.error('Account is null 2')
    return
  }
  console.log('sudoMint', chainId, token, account)
  const client: PublicClient | undefined = getPublicClient(wagmiConfig, { chainId })
  if (client == null) {
    throw new Error('Client is null')
  }
  await debugSetTokenAmount(client, token, account, parseUnits('150', 6))
  await setEthBalance(account, '70', client)
  callback()
}

/**
 * A helper function to set the ETH balance of an account on a test chain.
 */
async function setEthBalance (accountAddress: Address, amountUnits: string, client: PublicClient): Promise<void> {
  const amountWei = parseUnits(amountUnits, 18)
  await client.request({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    method: 'hardhat_setBalance' as any,
    params: [accountAddress, toHex(amountWei)]
  })
  console.log(`Set balance of ${accountAddress} to ${formatEther(amountWei)} ETH`)
}
