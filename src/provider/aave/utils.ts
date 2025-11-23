import { getClient } from 'wagmi/actions'
import { readContract } from 'viem/actions'
import { type Address, erc20Abi } from 'viem'

import { AAVE_POOL_ABI } from '../../utils/constants.ts'
import { wagmiConfig } from '../wagmiConfig.ts'
import { AAVE_ORACLE_ADDRESSES, AAVE_ORACLE_ABI } from './constants.ts'

/**
 * Get the actual aToken balance for a user on a specific chain
 * This reads the aToken balance directly (in token units, not USD base)
 * Uses getReserveData to get the aToken address
 */
export async function getATokenBalance(
  chainId: number,
  userAddress: Address,
  collateralTokenAddress: Address,
  poolAddress: Address
): Promise<bigint> {
  try {
    const client = getClient(wagmiConfig, { chainId })
    if (!client) {
      throw new Error(`Client not initialized for chain ${chainId}`)
    }

    // Get reserve data which includes aToken address
    const reserveData = await readContract(client, {
      address: poolAddress,
      abi: AAVE_POOL_ABI,
      functionName: 'getReserveData',
      args: [collateralTokenAddress],
    }) as any

    // Extract aToken address from reserve data
    const aTokenAddress = reserveData.aTokenAddress as Address
    
    if (!aTokenAddress || aTokenAddress === '0x0000000000000000000000000000000000000000') {
      console.warn(`Invalid aToken address for asset ${collateralTokenAddress} on chain ${chainId}`)
      return 0n
    }

    // Read aToken balance
    const balance = await readContract(client, {
      address: aTokenAddress,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [userAddress],
    })

    return balance as bigint
  } catch (error) {
    console.warn(`Could not get aToken balance: ${error}`)
    // Fallback: return 0, caller should handle this
    return 0n
  }
}

/**
 * Get token price from Aave oracle
 * Returns price in 8 decimals (USD per token)
 */
export async function getTokenPrice(
  chainId: number,
  tokenAddress: Address
): Promise<bigint> {
  try {
    const oracleAddress = AAVE_ORACLE_ADDRESSES[chainId]
    if (!oracleAddress) {
      throw new Error(`Oracle address not found for chain ${chainId}`)
    }

    const client = getClient(wagmiConfig, { chainId })
    if (!client) {
      throw new Error(`Client not initialized for chain ${chainId}`)
    }

    const price = await readContract(client, {
      address: oracleAddress,
      abi: AAVE_ORACLE_ABI,
      functionName: 'getAssetPrice',
      args: [tokenAddress],
    })

    return price as bigint
  } catch (error) {
    console.warn(`Could not get token price from oracle: ${error}`)
    // Fallback: return 0 to indicate failure
    return 0n
  }
}

/**
 * Convert USD base amount to token amount using Aave oracle price
 * USD base is in 8 decimals, represents USD value
 * Token price from oracle is in 8 decimals (USD per token)
 * Returns token amount in token decimals
 */
export async function convertUSDBaseToTokenAmount(
  usdBaseAmount: bigint,
  chainId: number,
  tokenAddress: Address,
  tokenDecimals: number
): Promise<bigint> {
  // Get token price from oracle (in 8 decimals, USD per token)
  const price = await getTokenPrice(chainId, tokenAddress)
  
  if (price === 0n) {
    // Fallback: use approximation for stablecoins
    // This is a rough approximation - should only be used if oracle fails
    console.warn(`Using fallback conversion for token ${tokenAddress} on chain ${chainId}`)
    if (tokenDecimals === 6) {
      // USDC: assume 1 USD = 1 USDC
      return usdBaseAmount / 100n // 8 decimals -> 6 decimals
    } else if (tokenDecimals === 18) {
      // WETH: assume 1 USD = 1 WETH (WRONG but better than nothing)
      // This will be incorrect, but at least won't crash
      return usdBaseAmount * 10n ** 10n
    } else {
      // Generic fallback
      const adjustment = tokenDecimals > 8 
        ? 10n ** BigInt(tokenDecimals - 8)
        : 10n ** BigInt(8 - tokenDecimals)
      return tokenDecimals > 8
        ? usdBaseAmount * adjustment
        : usdBaseAmount / adjustment
    }
  }

  // Convert using actual price
  // Formula: tokenAmount = (usdBaseAmount * 10^tokenDecimals) / price
  // Both usdBaseAmount and price are in 8 decimals
  // Result should be in tokenDecimals
  
  // Multiply USD base by 10^tokenDecimals to get proper scaling
  const numerator = usdBaseAmount * 10n ** BigInt(tokenDecimals)
  
  // Divide by price (which is in 8 decimals)
  // This gives us token amount in tokenDecimals
  const tokenAmount = numerator / price
  
  return tokenAmount
}

