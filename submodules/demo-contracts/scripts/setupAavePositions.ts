import { network } from 'hardhat'
import { parseUnits, formatUnits, Address, erc20Abi, maxUint256 } from 'viem'
import { getBalance } from 'viem/actions'
import { type PublicClient, type WalletClient } from 'viem'
import {
  AAVE_POOL_ABI,
  WETH_ABI,
} from './constants.js'
import {
  getNetworkClients,
  getAavePoolAddress,
  getUsdcAddress,
  getTokenAddress,
  verifyChainId,
} from './helpers.js'
import configData from './aavePositionsConfig.json'

// ============================================================================
// Types
// ============================================================================

interface ChainConfig {
  chainId: number
  name?: string
  supplyAmount: string // Human-readable amount (e.g., "1000" or "2.5")
  borrowAmount: string // Human-readable amount (e.g., "200" or "0")
  collateralToken?: string | Address // "USDC", "WETH", or address
  borrowToken?: string | Address // "USDC", "WETH", or address
}

interface PositionState {
  totalCollateralBase: bigint
  totalDebtBase: bigint
  healthFactor: bigint
  hasPosition: boolean
}

interface TokenInfo {
  address: Address
  decimals: number
  symbol: string
}

// ============================================================================
// Core Operations
// ============================================================================

/**
 * Get current Aave position state
 */
async function getCurrentPosition(
  publicClient: PublicClient,
  poolAddress: Address,
  userAddress: Address
): Promise<PositionState> {
  const accountData = await publicClient.readContract({
    address: poolAddress,
    abi: AAVE_POOL_ABI,
    functionName: 'getUserAccountData',
    args: [userAddress],
  }) as [bigint, bigint, bigint, bigint, bigint, bigint]

  const [totalCollateralBase, totalDebtBase, , , , healthFactor] = accountData

  return {
    totalCollateralBase,
    totalDebtBase,
    healthFactor,
    hasPosition: totalCollateralBase > 0n || totalDebtBase > 0n,
  }
}

/**
 * Get token info (address, decimals, symbol)
 */
async function getTokenInfo(
  publicClient: PublicClient,
  chainId: number,
  token: string | Address | undefined,
  defaultToken: string = 'USDC'
): Promise<TokenInfo> {
  // Resolve address
  let address: Address
  if (!token) {
    address = getUsdcAddress(chainId)
  } else if (typeof token === 'string') {
    address = getTokenAddress(token, chainId)
  } else {
    address = token
  }

  // Get decimals
  const decimals = await publicClient.readContract({
    address,
    abi: erc20Abi,
    functionName: 'decimals',
  }) as number

  // Try to get symbol
  let symbol: string
  try {
    symbol = await publicClient.readContract({
      address,
      abi: erc20Abi,
      functionName: 'symbol',
    }) as string
  } catch {
    symbol = typeof token === 'string' ? token : address.slice(0, 10) + '...'
  }

  return { address, decimals, symbol }
}

/**
 * Get actual aToken balance for a collateral asset using getReserveData
 */
async function getATokenBalance(
  publicClient: PublicClient,
  poolAddress: Address,
  collateralTokenAddress: Address,
  userAddress: Address
): Promise<bigint> {
  try {
    // Get reserve data which includes aToken address
    const reserveData = await publicClient.readContract({
      address: poolAddress,
      abi: AAVE_POOL_ABI,
      functionName: 'getReserveData',
      args: [collateralTokenAddress],
    }) as any

    // Extract aToken address from reserve data
    const aTokenAddress = reserveData.aTokenAddress as Address
    
    if (!aTokenAddress || aTokenAddress === '0x0000000000000000000000000000000000000000') {
      return 0n
    }

    // Read aToken balance
    const balance = await publicClient.readContract({
      address: aTokenAddress,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [userAddress],
    })

    return balance as bigint
  } catch (error) {
    console.warn(`Could not get aToken balance: ${error}`)
    return 0n
  }
}

/**
 * Ensure account has sufficient token balance (wrap ETH if needed for WETH)
 */
async function ensureTokenBalance(
  publicClient: PublicClient,
  walletClient: WalletClient,
  tokenInfo: TokenInfo,
  neededAmount: bigint,
  accountAddress: Address
): Promise<void> {
  const isWETH = tokenInfo.symbol === 'WETH' || tokenInfo.address.toLowerCase() === getTokenAddress('WETH', (publicClient.chain?.id || 0)).toLowerCase()

  let availableBalance: bigint

  if (isWETH) {
    // Check both ETH and WETH balances
    let ethBalance = await getBalance(publicClient, { address: accountAddress })
    let wethBalance = await publicClient.readContract({
      address: tokenInfo.address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [accountAddress],
    }) as bigint

    // Wrap ETH if needed - keep wrapping until we have enough or run out of ETH
    while (wethBalance < neededAmount && ethBalance > 0n) {
      // Calculate how much ETH we need to wrap
      const wethNeeded = neededAmount - wethBalance
      // Reserve some ETH for gas (0.01 ETH)
      const gasReserve = parseUnits('0.01', 18)
      const availableToWrap = ethBalance > gasReserve ? ethBalance - gasReserve : 0n
      
      if (availableToWrap <= 0n) {
        console.log(`   ⚠️  Not enough ETH to wrap (need gas reserve). Available: ${formatUnits(ethBalance, 18)} ETH`)
        break
      }
      
      const ethToWrap = wethNeeded < availableToWrap ? wethNeeded : availableToWrap
      console.log(`   📝 Wrapping ${formatUnits(ethToWrap, 18)} ETH to WETH...`)
      
      const wrapHash = await walletClient.writeContract({
        address: tokenInfo.address,
        abi: WETH_ABI,
        functionName: 'deposit',
        value: ethToWrap,
      } as any)
      
      await publicClient.waitForTransactionReceipt({ hash: wrapHash })
      console.log(`   ✅ Wrapped ETH (tx: ${wrapHash})`)
      
      // Re-check balances after wrapping
      ethBalance = await getBalance(publicClient, { address: accountAddress })
      wethBalance = await publicClient.readContract({
        address: tokenInfo.address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [accountAddress],
      }) as bigint
    }

    availableBalance = ethBalance + wethBalance
  } else {
    availableBalance = await publicClient.readContract({
      address: tokenInfo.address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [accountAddress],
    }) as bigint
  }

  if (availableBalance < neededAmount) {
    throw new Error(
      `Insufficient ${tokenInfo.symbol} balance. ` +
      `Have: ${formatUnits(availableBalance, tokenInfo.decimals)}, ` +
      `Need: ${formatUnits(neededAmount, tokenInfo.decimals)}`
    )
  }

  console.log(`   ✅ Sufficient balance: ${formatUnits(availableBalance, tokenInfo.decimals)} ${tokenInfo.symbol}`)
}

/**
 * Ensure Aave pool has approval to spend tokens
 */
async function ensureApproval(
  publicClient: PublicClient,
  walletClient: WalletClient,
  tokenAddress: Address,
  spenderAddress: Address,
  amount: bigint,
  accountAddress: Address
): Promise<void> {
  const currentAllowance = await publicClient.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [accountAddress, spenderAddress],
  }) as bigint

  if (currentAllowance < amount) {
    console.log(`   📝 Approving spender...`)
    const approveHash = await walletClient.writeContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: 'approve',
      args: [spenderAddress, maxUint256],
    } as any)
    
    await publicClient.waitForTransactionReceipt({ hash: approveHash })
    console.log(`   ✅ Approved (tx: ${approveHash})`)
  } else {
    console.log(`   ✅ Sufficient approval`)
  }
}

/**
 * Supply exact target amount
 * Note: Position should already be reset before calling this function
 */
async function adjustSupply(
  publicClient: PublicClient,
  walletClient: WalletClient,
  poolAddress: Address,
  collateralToken: TokenInfo,
  targetSupply: bigint,
  accountAddress: Address
): Promise<void> {
  // Get current aToken balance (should be 0 after reset)
  const currentATokenBalance = await getATokenBalance(
    publicClient,
    poolAddress,
    collateralToken.address,
    accountAddress
  )

  console.log(`   Current Supply: ${formatUnits(currentATokenBalance, collateralToken.decimals)} ${collateralToken.symbol}`)
  console.log(`   Target Supply: ${formatUnits(targetSupply, collateralToken.decimals)} ${collateralToken.symbol}`)

  if (targetSupply === 0n) {
    if (currentATokenBalance > 0n) {
      console.log(`   ⚠️  Unexpected: Found existing collateral after reset. Withdrawing...`)
      const withdrawHash = await walletClient.writeContract({
        address: poolAddress,
        abi: AAVE_POOL_ABI,
        functionName: 'withdraw',
        args: [collateralToken.address, maxUint256, accountAddress],
      } as any)
      await publicClient.waitForTransactionReceipt({ hash: withdrawHash })
      console.log(`   ✅ Withdrew remaining collateral (tx: ${withdrawHash})`)
    } else {
      console.log(`   ✅ Target supply is 0, no action needed`)
    }
    return
  }

  // Verify we have enough balance
  const currentBalance = await publicClient.readContract({
    address: collateralToken.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [accountAddress],
  }) as bigint

  if (currentBalance < targetSupply) {
    throw new Error(
      `Insufficient balance. ` +
      `Have: ${formatUnits(currentBalance, collateralToken.decimals)} ${collateralToken.symbol}, ` +
      `Need: ${formatUnits(targetSupply, collateralToken.decimals)} ${collateralToken.symbol}`
    )
  }

  // If there's unexpected existing supply, withdraw it first
  if (currentATokenBalance > 0n) {
    console.log(`   ⚠️  Found existing supply after reset. Withdrawing first...`)
    const withdrawHash = await walletClient.writeContract({
      address: poolAddress,
      abi: AAVE_POOL_ABI,
      functionName: 'withdraw',
      args: [collateralToken.address, maxUint256, accountAddress],
    } as any)
    await publicClient.waitForTransactionReceipt({ hash: withdrawHash })
    console.log(`   ✅ Withdrew existing collateral (tx: ${withdrawHash})`)
  }

  // Supply exact target amount
  console.log(`   📝 Supplying exact target amount...`)
  
  const supplyHash = await walletClient.writeContract({
    address: poolAddress,
    abi: AAVE_POOL_ABI,
    functionName: 'supply',
    args: [collateralToken.address, targetSupply, accountAddress, 0],
  } as any)
  
  const receipt = await publicClient.waitForTransactionReceipt({ hash: supplyHash })
  
  if (receipt.status === 'success') {
    console.log(`   ✅ Supplied ${formatUnits(targetSupply, collateralToken.decimals)} ${collateralToken.symbol} (tx: ${supplyHash})`)
  } else {
    throw new Error(`Supply transaction failed: ${supplyHash}`)
  }
}

/**
 * Get current debt balance in token units using getReserveData
 */
async function getCurrentDebtBalance(
  publicClient: PublicClient,
  poolAddress: Address,
  borrowToken: TokenInfo,
  accountAddress: Address
): Promise<bigint> {
  try {
    // Get reserve data which includes variable debt token address
    const reserveData = await publicClient.readContract({
      address: poolAddress,
      abi: AAVE_POOL_ABI,
      functionName: 'getReserveData',
      args: [borrowToken.address],
    }) as any

    // Extract variable debt token address from reserve data
    // Structure: ReserveData { ..., aTokenAddress, stableDebtTokenAddress, variableDebtTokenAddress, ... }
    const variableDebtTokenAddress = reserveData.variableDebtTokenAddress as Address
    
    if (!variableDebtTokenAddress || variableDebtTokenAddress === '0x0000000000000000000000000000000000000000') {
      return 0n
    }
    
    // Read variable debt token balance (in token units)
    const currentDebt = await publicClient.readContract({
      address: variableDebtTokenAddress,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [accountAddress],
    }) as bigint

    return currentDebt
  } catch (error) {
    console.warn(`   ⚠️  Could not read variable debt token balance: ${error}`)
    // Return 0 if we can't read it - we'll try operations anyway
    return 0n
  }
}

/**
 * Adjust borrow to target amount
 */
async function adjustBorrow(
  publicClient: PublicClient,
  walletClient: WalletClient,
  poolAddress: Address,
  borrowToken: TokenInfo,
  targetBorrow: bigint,
  accountAddress: Address
): Promise<void> {
  // Get current debt balance in token units
  const currentDebt = await getCurrentDebtBalance(
    publicClient,
    poolAddress,
    borrowToken,
    accountAddress
  )

  console.log(`   Current Debt: ${formatUnits(currentDebt, borrowToken.decimals)} ${borrowToken.symbol}`)
  console.log(`   Target Debt: ${formatUnits(targetBorrow, borrowToken.decimals)} ${borrowToken.symbol}`)

  const difference = targetBorrow - currentDebt

  if (difference === 0n) {
    console.log(`   ✅ Borrow already matches target`)
    return
  }

  if (difference > 0n) {
    // Need to borrow more
    console.log(`   📝 Borrowing ${formatUnits(difference, borrowToken.decimals)} ${borrowToken.symbol}...`)
    
    try {
      const borrowHash = await walletClient.writeContract({
        address: poolAddress,
        abi: AAVE_POOL_ABI,
        functionName: 'borrow',
        args: [borrowToken.address, difference, 2n, 0n, accountAddress],
      } as any)
      
      const receipt = await publicClient.waitForTransactionReceipt({ hash: borrowHash })
      
      if (receipt.status === 'success') {
        console.log(`   ✅ Borrowed successfully (tx: ${borrowHash})`)
      } else {
        throw new Error(`Borrow transaction failed: ${borrowHash}`)
      }
    } catch (error) {
      console.error(`   ❌ Error borrowing: ${error}`)
      throw error
    }
  } else {
    // Need to repay excess
    const repayAmount = -difference
    console.log(`   📝 Repaying ${formatUnits(repayAmount, borrowToken.decimals)} ${borrowToken.symbol}...`)
    
    // Ensure we have approval for repayment
    await ensureApproval(
      publicClient,
      walletClient,
      borrowToken.address,
      poolAddress,
      repayAmount,
      accountAddress
    )
    
    try {
      const repayHash = await walletClient.writeContract({
        address: poolAddress,
        abi: AAVE_POOL_ABI,
        functionName: 'repay',
        args: [borrowToken.address, repayAmount, 2n, accountAddress],
      } as any)
      
      const receipt = await publicClient.waitForTransactionReceipt({ hash: repayHash })
      
      if (receipt.status === 'success') {
        console.log(`   ✅ Repaid successfully (tx: ${repayHash})`)
      } else {
        throw new Error(`Repay transaction failed: ${repayHash}`)
      }
    } catch (error) {
      console.error(`   ❌ Error repaying: ${error}`)
      throw error
    }
  }
}

// ============================================================================
// Reset Functions
// ============================================================================

/**
 * Reset position completely - repay all debt and withdraw all collateral
 * This ensures we start from a fresh state before setting up the new position
 */
async function resetPosition(
  publicClient: PublicClient,
  walletClient: WalletClient,
  poolAddress: Address,
  chainId: number,
  accountAddress: Address
): Promise<void> {
  const position = await getCurrentPosition(publicClient, poolAddress, accountAddress)
  
  if (!position.hasPosition) {
    console.log(`   ✅ No existing position to reset`)
    return
  }

  console.log(`\n🔄 Resetting Position:`)
  console.log(`   Current Collateral (USD base): ${formatUnits(position.totalCollateralBase, 8)}`)
  console.log(`   Current Debt (USD base): ${formatUnits(position.totalDebtBase, 8)}`)

  // Step 1: Repay all debt (try common tokens: USDC and WETH, retry if needed)
  if (position.totalDebtBase > 0n) {
    console.log(`\n   📝 Step 1: Repaying all debt...`)
    
    const tokensToTry = ['USDC', 'WETH']
    let attempts = 0
    const maxAttempts = 3 // Try up to 3 times to handle interest accrual
    
    while (attempts < maxAttempts) {
      attempts++
      if (attempts > 1) {
        console.log(`      Retry attempt ${attempts}/${maxAttempts}...`)
      }
      
      for (const tokenSymbol of tokensToTry) {
        try {
          const tokenInfo = await getTokenInfo(publicClient, chainId, tokenSymbol)
          const currentDebt = await getCurrentDebtBalance(
            publicClient,
            poolAddress,
            tokenInfo,
            accountAddress
          )
          
          if (currentDebt > 0n) {
            console.log(`      Repaying ${tokenInfo.symbol} debt (${formatUnits(currentDebt, tokenInfo.decimals)} ${tokenInfo.symbol})...`)
            
            // Check if we have balance to repay
            const balance = await publicClient.readContract({
              address: tokenInfo.address,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [accountAddress],
            }) as bigint
            
            if (balance > 0n) {
              await ensureApproval(publicClient, walletClient, tokenInfo.address, poolAddress, maxUint256, accountAddress)
              
              // Use maxUint256 to repay maximum possible (Aave will repay what's available)
              const repayHash = await walletClient.writeContract({
                address: poolAddress,
                abi: AAVE_POOL_ABI,
                functionName: 'repay',
                args: [tokenInfo.address, maxUint256, 2n, accountAddress],
              } as any)
              
              const receipt = await publicClient.waitForTransactionReceipt({ hash: repayHash })
              if (receipt.status === 'success') {
                // Get actual repaid amount by checking debt before and after
                const debtAfter = await getCurrentDebtBalance(
                  publicClient,
                  poolAddress,
                  tokenInfo,
                  accountAddress
                )
                const repaidAmount = currentDebt - debtAfter
                console.log(`      ✅ Repaid ${formatUnits(repaidAmount, tokenInfo.decimals)} ${tokenInfo.symbol} (tx: ${repayHash})`)
              }
            } else {
              console.log(`      ⚠️  No balance to repay ${tokenInfo.symbol} debt`)
            }
          }
        } catch (error) {
          // Continue with other tokens
          console.log(`      ⚠️  Could not repay ${tokenSymbol}: ${error}`)
        }
      }
      
      // Check if debt is cleared
      const positionAfterRepay = await getCurrentPosition(publicClient, poolAddress, accountAddress)
      if (positionAfterRepay.totalDebtBase === 0n) {
        console.log(`      ✅ All debt repaid`)
        break
      } else if (attempts < maxAttempts) {
        const remainingDebtUSD = formatUnits(positionAfterRepay.totalDebtBase, 8)
        console.log(`      ⚠️  Some debt remains: ${remainingDebtUSD} USD base - will retry...`)
        // Small delay before retry to allow for any state updates
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }
    
    // Final check
    const finalPosition = await getCurrentPosition(publicClient, poolAddress, accountAddress)
    if (finalPosition.totalDebtBase > 0n) {
      const remainingDebtUSD = formatUnits(finalPosition.totalDebtBase, 8)
      console.warn(`      ⚠️  Some debt remains after ${maxAttempts} attempts: ${remainingDebtUSD} USD base`)
      console.warn(`      ⚠️  This may prevent collateral withdrawal. You may need to manually repay or wait for liquidation.`)
    }
  }

  // Step 2: Withdraw all collateral (try common tokens: USDC and WETH)
  // Check if there's still debt - if so, try withdrawing anyway (might work for small amounts)
  const positionBeforeWithdraw = await getCurrentPosition(publicClient, poolAddress, accountAddress)
  if (positionBeforeWithdraw.totalDebtBase > 0n) {
    const remainingDebtUSD = formatUnits(positionBeforeWithdraw.totalDebtBase, 8)
    console.log(`\n   ⚠️  Note: ${remainingDebtUSD} USD base debt remains. Will attempt withdrawal anyway...`)
  }
  
  if (position.totalCollateralBase > 0n) {
    console.log(`\n   📝 Step 2: Withdrawing all collateral...`)
    
    const tokensToTry = ['USDC', 'WETH']
    
    for (const tokenSymbol of tokensToTry) {
      try {
        const tokenInfo = await getTokenInfo(publicClient, chainId, tokenSymbol)
        const currentATokenBalance = await getATokenBalance(
          publicClient,
          poolAddress,
          tokenInfo.address,
          accountAddress
        )
        
        if (currentATokenBalance > 0n) {
          console.log(`      Withdrawing ${formatUnits(currentATokenBalance, tokenInfo.decimals)} ${tokenInfo.symbol}...`)
          
          try {
            const withdrawHash = await walletClient.writeContract({
              address: poolAddress,
              abi: AAVE_POOL_ABI,
              functionName: 'withdraw',
              args: [tokenInfo.address, maxUint256, accountAddress],
            } as any)
            
            const receipt = await publicClient.waitForTransactionReceipt({ hash: withdrawHash })
            if (receipt.status === 'success') {
              // Check how much was actually withdrawn
              const balanceAfter = await getATokenBalance(
                publicClient,
                poolAddress,
                tokenInfo.address,
                accountAddress
              )
              const withdrawnAmount = currentATokenBalance - balanceAfter
              console.log(`      ✅ Withdrew ${formatUnits(withdrawnAmount, tokenInfo.decimals)} ${tokenInfo.symbol} (tx: ${withdrawHash})`)
              
              // If there's still balance, try one more time
              if (balanceAfter > 0n) {
                console.log(`      📝 Attempting to withdraw remaining ${formatUnits(balanceAfter, tokenInfo.decimals)} ${tokenInfo.symbol}...`)
                const withdrawHash2 = await walletClient.writeContract({
                  address: poolAddress,
                  abi: AAVE_POOL_ABI,
                  functionName: 'withdraw',
                  args: [tokenInfo.address, maxUint256, accountAddress],
                } as any)
                await publicClient.waitForTransactionReceipt({ hash: withdrawHash2 })
                console.log(`      ✅ Second withdrawal completed (tx: ${withdrawHash2})`)
              }
            } else {
              console.warn(`      ⚠️  Withdrawal transaction failed for ${tokenInfo.symbol}`)
            }
          } catch (withdrawError: any) {
            // Check if error is due to debt
            const errorMsg = withdrawError?.message || String(withdrawError)
            if (errorMsg.includes('debt') || errorMsg.includes('health factor') || errorMsg.includes('collateral')) {
              console.warn(`      ⚠️  Cannot withdraw ${tokenInfo.symbol} due to remaining debt or health factor constraints`)
              console.warn(`      ⚠️  You may need to repay the remaining debt first or wait for liquidation`)
            } else {
              console.warn(`      ⚠️  Withdrawal failed for ${tokenInfo.symbol}: ${errorMsg}`)
            }
          }
        }
      } catch (error) {
        // Continue with other tokens
        console.log(`      ⚠️  Could not withdraw ${tokenSymbol}: ${error}`)
      }
    }
    
    // Verify collateral is cleared
    const positionAfterWithdraw = await getCurrentPosition(publicClient, poolAddress, accountAddress)
    if (positionAfterWithdraw.totalCollateralBase > 0n) {
      const remainingCollateralUSD = formatUnits(positionAfterWithdraw.totalCollateralBase, 8)
      console.warn(`      ⚠️  Some collateral remains: ${remainingCollateralUSD} USD base`)
      if (positionAfterWithdraw.totalDebtBase > 0n) {
        const remainingDebtUSD = formatUnits(positionAfterWithdraw.totalDebtBase, 8)
        console.warn(`      ⚠️  Remaining debt: ${remainingDebtUSD} USD base - this may be preventing withdrawal`)
      }
    } else {
      console.log(`      ✅ All collateral withdrawn`)
    }
  }

  console.log(`\n   ✅ Position reset complete - ready for fresh setup`)
}

// ============================================================================
// Main Setup Function
// ============================================================================

/**
 * Setup Aave position for a single chain
 */
async function setupPosition(chainConfig: ChainConfig): Promise<void> {
  const { chainId, supplyAmount, borrowAmount, collateralToken, borrowToken } = chainConfig

  console.log(`\n${'='.repeat(60)}`)
  console.log(`📍 Chain ${chainId}${chainConfig.name ? ` (${chainConfig.name})` : ''}`)
  console.log(`${'='.repeat(60)}`)

  // Get network clients
  const { publicClient, walletClient, accountAddress, chainId: currentChainId } = await getNetworkClients()
  verifyChainId(currentChainId, chainId)

  console.log(`👤 Account: ${accountAddress}`)

  // Get token info
  const collateralTokenInfo = await getTokenInfo(publicClient, chainId, collateralToken)
  const borrowTokenInfo = await getTokenInfo(publicClient, chainId, borrowToken)

  const poolAddress = getAavePoolAddress(chainId)

  console.log(`\n📊 Configuration:`)
  console.log(`   Pool: ${poolAddress}`)
  console.log(`   Collateral: ${collateralTokenInfo.symbol} (${collateralTokenInfo.address})`)
  console.log(`   Borrow: ${borrowTokenInfo.symbol} (${borrowTokenInfo.address})`)
  console.log(`   Target Supply: ${supplyAmount} ${collateralTokenInfo.symbol}`)
  console.log(`   Target Borrow: ${borrowAmount} ${borrowTokenInfo.symbol}`)

  // Parse target amounts
  const targetSupply = parseUnits(supplyAmount, collateralTokenInfo.decimals)
  const targetBorrow = parseUnits(borrowAmount, borrowTokenInfo.decimals)

  // Get current position
  console.log(`\n🔍 Current Position:`)
  const currentPosition = await getCurrentPosition(publicClient, poolAddress, accountAddress)
  
  if (currentPosition.hasPosition) {
    console.log(`   Collateral (USD base): ${formatUnits(currentPosition.totalCollateralBase, 8)}`)
    console.log(`   Debt (USD base): ${formatUnits(currentPosition.totalDebtBase, 8)}`)
    console.log(`   Health Factor: ${currentPosition.healthFactor === 0n ? 'N/A (no debt)' : formatUnits(currentPosition.healthFactor, 18)}`)
    
    // Step 0: Reset position completely - repay all debt and withdraw all collateral
    await resetPosition(publicClient, walletClient, poolAddress, chainId, accountAddress)
  } else {
    console.log(`   No existing position - proceeding with fresh setup`)
  }

  // Step 1: Ensure token balance
  console.log(`\n1️⃣ Checking Token Balance:`)
  const neededBalance = targetSupply + (targetBorrow > 0n ? parseUnits('100', borrowTokenInfo.decimals) : 0n) // Buffer for repayments
  await ensureTokenBalance(publicClient, walletClient, collateralTokenInfo, targetSupply, accountAddress)

  // Step 2: Ensure approvals
  console.log(`\n2️⃣ Checking Approvals:`)
  await ensureApproval(publicClient, walletClient, collateralTokenInfo.address, poolAddress, targetSupply, accountAddress)
  if (targetBorrow > 0n) {
    await ensureApproval(publicClient, walletClient, borrowTokenInfo.address, poolAddress, targetBorrow, accountAddress)
  }

  // Step 3: Adjust supply (will reset by withdrawing all, then supplying exact target)
  console.log(`\n3️⃣ Adjusting Supply:`)
  await adjustSupply(publicClient, walletClient, poolAddress, collateralTokenInfo, targetSupply, accountAddress)

  // Step 4: Adjust borrow
  console.log(`\n4️⃣ Adjusting Borrow:`)
  if (targetBorrow > 0n) {
    await adjustBorrow(publicClient, walletClient, poolAddress, borrowTokenInfo, targetBorrow, accountAddress)
  } else {
    // If target is 0, ensure all debt is repaid
    const position = await getCurrentPosition(publicClient, poolAddress, accountAddress)
    if (position.totalDebtBase > 0n) {
      console.log(`   📝 Repaying all remaining debt...`)
      await ensureApproval(publicClient, walletClient, borrowTokenInfo.address, poolAddress, maxUint256, accountAddress)
      
      const repayHash = await walletClient.writeContract({
        address: poolAddress,
        abi: AAVE_POOL_ABI,
        functionName: 'repay',
        args: [borrowTokenInfo.address, maxUint256, 2n, accountAddress],
      } as any)
      
      await publicClient.waitForTransactionReceipt({ hash: repayHash })
      console.log(`   ✅ Repaid all debt (tx: ${repayHash})`)
    } else {
      console.log(`   ✅ No debt to repay`)
    }
  }

  // Verify final state
  console.log(`\n✅ Final Position:`)
  const finalPosition = await getCurrentPosition(publicClient, poolAddress, accountAddress)
  console.log(`   Collateral (USD base): ${formatUnits(finalPosition.totalCollateralBase, 8)}`)
  console.log(`   Debt (USD base): ${formatUnits(finalPosition.totalDebtBase, 8)}`)
  console.log(`   Health Factor: ${finalPosition.healthFactor === 0n ? 'N/A (no debt)' : formatUnits(finalPosition.healthFactor, 18)}`)
  
  console.log(`\n🎉 Position setup complete!\n`)
}

// ============================================================================
// Configuration & Main
// ============================================================================

function loadConfig(): ChainConfig[] {
  const chains: ChainConfig[] = (configData.chains || []).map((chain: any) => ({
    chainId: chain.chainId,
    name: chain.name,
    supplyAmount: chain.supplyAmount,
    borrowAmount: chain.borrowAmount,
    collateralToken: chain.collateralToken || undefined,
    borrowToken: chain.borrowToken || undefined,
  }))

  if (chains.length === 0) {
    throw new Error('No chains configured in aavePositionsConfig.json')
  }

  return chains
}

/**
 * Main execution function
 * 
 * Usage:
 *   npx hardhat run scripts/setupAavePositions.ts --network arbitrum
 *   npx hardhat run scripts/setupAavePositions.ts --network base
 * 
 * This script sets up positions on ONE chain at a time.
 * Run it multiple times with different --network flags for multiple chains.
 */
async function main() {
  const config = loadConfig()
  
  // Get current network
  const { viem } = await network.connect()
  const publicClient = await viem.getPublicClient()
  const currentChainId = publicClient.chain?.id
  
  if (!currentChainId) {
    throw new Error('Could not determine current chain ID from network')
  }

  // Find config for current chain
  const chainConfig = config.find(c => c.chainId === currentChainId)
  
  if (!chainConfig) {
    console.log(`⚠️  No configuration found for chain ${currentChainId}`)
    console.log(`   Available chains in config: ${config.map(c => `${c.chainId}${c.name ? ` (${c.name})` : ''}`).join(', ')}`)
    return
  }

  await setupPosition(chainConfig)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
