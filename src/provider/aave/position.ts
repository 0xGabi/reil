import { getClient } from 'wagmi/actions'
import { readContract } from 'viem/actions'
import { type Address } from 'viem'
import { type IMultiChainSmartAccount } from '@eil-protocol/sdk'

import { AAVE_POOL_ABI, getAavePoolAddress } from '../../utils/constants.ts'
import { wagmiConfig } from '../wagmiConfig.ts'
import { type AavePosition } from './types.ts'

/**
 * Fetch Aave position data for a user on a specific chain
 */
export async function fetchAavePosition(
  chainId: number,
  userAddress: Address
): Promise<AavePosition | null> {
  const client = getClient(wagmiConfig, { chainId })
  if (!client) {
    throw new Error(`Client not initialized for chain ${chainId}`)
  }

  const poolAddress = getAavePoolAddress(chainId)

  if (!poolAddress) {
    console.warn(`Aave pool not found on chain ${chainId}`)
    return null
  }

  try {
    const accountData = await readContract(client, {
      address: poolAddress as Address,
      abi: AAVE_POOL_ABI,
      functionName: 'getUserAccountData',
      args: [userAddress],
    }) as [bigint, bigint, bigint, bigint, bigint, bigint]

    const [
      totalCollateralBase,
      totalDebtBase,
      availableBorrowsBase,
      currentLiquidationThreshold,
      ltv,
      healthFactor,
    ] = accountData

    return {
      chainId,
      healthFactor,
      totalCollateralBase,
      totalDebtBase,
      availableBorrowsBase,
      currentLiquidationThreshold,
      ltv,
      userAddress,
    }
  } catch (error) {
    console.error(`Error fetching Aave position on chain ${chainId}:`, error)
    return null
  }
}

/**
 * Fetch Aave positions across multiple chains
 */
export async function fetchAavePositions(
  chainIds: number[],
  account: IMultiChainSmartAccount
): Promise<AavePosition[]> {
  const positions = await Promise.all(
    chainIds.map(async (chainId) => {
      const smartAccount = account.contractOn(BigInt(chainId))
      if (!smartAccount?.address) return null
      return fetchAavePosition(chainId, smartAccount.address)
    })
  )

  return positions.filter((pos): pos is AavePosition => pos !== null)
}

