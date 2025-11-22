import { network } from 'hardhat'
import { parseUnits, formatUnits, Address, erc20Abi, maxUint256 } from 'viem'
import {
  AAVE_POOL_ABI,
} from './constants.js'
import {
  getNetworkClients,
  getAavePoolAddress,
  getUsdcAddress,
  verifyChainId,
} from './helpers.js'
import configData from './aavePositionsConfig.json'

interface ChainConfig {
  chainId: number
  supplyAmount: string // Amount in human-readable format (e.g., "1000")
  borrowAmount: string // Amount in human-readable format (e.g., "500")
  collateralToken?: Address // Optional, defaults to USDC
  borrowToken?: Address // Optional, defaults to USDC
}

interface SetupConfig {
  chains: ChainConfig[]
}

/**
 * Setup Aave positions for a given account across multiple chains
 * Always ensures positions match the config values
 */
async function setupAavePositions(config: SetupConfig) {
  const { chains } = config

  console.log(`\n🚀 Setting up Aave positions`)
  console.log(`📋 Configuring ${chains.length} chain(s)`)
  console.log(`📝 This script will ensure positions match config values\n`)

  for (const chainConfig of chains) {
    const { chainId, supplyAmount, borrowAmount, collateralToken, borrowToken } = chainConfig

    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
    console.log(`📍 Chain ${chainId}`)
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)

    try {
      // Get network clients using helper function
      // This will use Hardhat's configured accounts
      const { publicClient, walletClient, accountAddress, chainId: currentChainId } = await getNetworkClients()
      
      console.log(`📝 Using account: ${accountAddress}`)
      
      // Verify we're on the correct chain
      verifyChainId(currentChainId, chainId)

      // Get token addresses using helper functions
      const collateralAsset = collateralToken || getUsdcAddress(chainId)
      const borrowAsset = borrowToken || getUsdcAddress(chainId)
      const poolAddress = getAavePoolAddress(chainId)

      console.log(`📊 Configuration:`)
      console.log(`   Pool: ${poolAddress}`)
      console.log(`   Collateral Token: ${collateralAsset}`)
      console.log(`   Borrow Token: ${borrowAsset}`)
      console.log(`   Target Supply Amount: ${supplyAmount}`)
      console.log(`   Target Borrow Amount: ${borrowAmount}`)

      // Get token decimals
      const collateralDecimals = await publicClient.readContract({
        address: collateralAsset,
        abi: erc20Abi,
        functionName: 'decimals',
      })

      const borrowDecimals = await publicClient.readContract({
        address: borrowAsset,
        abi: erc20Abi,
        functionName: 'decimals',
      })

      // Parse target amounts
      const targetSupplyWei = parseUnits(supplyAmount, collateralDecimals)
      const targetBorrowWei = parseUnits(borrowAmount, borrowDecimals)

      console.log(`\n💰 Target Amounts:`)
      console.log(`   Supply: ${formatUnits(targetSupplyWei, collateralDecimals)} (${targetSupplyWei.toString()} wei)`)
      console.log(`   Borrow: ${formatUnits(targetBorrowWei, borrowDecimals)} (${targetBorrowWei.toString()} wei)`)

      // Check current position state
      console.log(`\n🔍 Checking current position state...`)
      const accountData = await publicClient.readContract({
        address: poolAddress,
        abi: AAVE_POOL_ABI,
        functionName: 'getUserAccountData',
        args: [accountAddress],
      }) as [bigint, bigint, bigint, bigint, bigint, bigint]

      const [totalCollateralBase, totalDebtBase, , , , healthFactor] = accountData
      const hasExistingPosition = totalCollateralBase > 0n || totalDebtBase > 0n

      if (hasExistingPosition) {
        console.log(`   Current Collateral (USD base): ${formatUnits(totalCollateralBase, 8)}`)
        console.log(`   Current Debt (USD base): ${formatUnits(totalDebtBase, 8)}`)
        console.log(`   Health Factor: ${healthFactor === 0n ? 'N/A (no debt)' : formatUnits(healthFactor, 18)}`)
        console.log(`   📊 Will adjust position to match config`)
      } else {
        console.log(`   ✅ No existing position found - will create new position`)
      }

      // Step 1: If there's existing debt, repay it first (if target is less or zero)
      if (totalDebtBase > 0n && targetBorrowWei < totalDebtBase) {
        console.log(`\n1️⃣ Repaying excess debt...`)
        try {
          // Repay all debt first (we'll borrow the target amount later)
          // Interest rate mode: 2 = variable
          const repayHash = await walletClient.writeContract({
            address: poolAddress,
            abi: AAVE_POOL_ABI,
            functionName: 'repay',
            args: [borrowAsset, maxUint256, 2n, accountAddress],
          } as any)
          await publicClient.waitForTransactionReceipt({ hash: repayHash })
          console.log(`   ✅ Repaid debt (tx: ${repayHash})`)
        } catch (e) {
          console.log(`   ⚠️  Could not repay debt: ${e}`)
          // Continue anyway - might not have enough tokens to repay
        }
      }

      // Step 2: If there's existing collateral and we need less, withdraw excess
      // Note: We can't easily get exact aToken balance, so we'll handle this after
      // For now, we'll proceed with setting up the position
      // The supply function will add to existing, so we need to handle this carefully
      // Actually, Aave supply adds to existing, so we need to calculate the difference
      
      // Step 2: Check if account has enough tokens
      console.log(`\n2️⃣ Checking token balance...`)
      const accountBalance = await publicClient.readContract({
        address: collateralAsset,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [accountAddress],
      })

      // Calculate needed amount: target supply + buffer for repayments if needed
      const neededAmount = targetSupplyWei + (totalDebtBase > 0n ? parseUnits('1000', borrowDecimals) : 0n)
      if (accountBalance < neededAmount) {
        throw new Error(`Insufficient tokens. Account has ${formatUnits(accountBalance, collateralDecimals)}, needs ${formatUnits(neededAmount, collateralDecimals)}`)
      }
      console.log(`   ✅ Sufficient balance: ${formatUnits(accountBalance, collateralDecimals)}`)

      // Step 3: Approve Aave pool to spend tokens
      console.log(`\n3️⃣ Checking and setting approval...`)
      
      const currentAllowance = await publicClient.readContract({
        address: collateralAsset,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [accountAddress, poolAddress],
      })

      if (currentAllowance < targetSupplyWei) {
        console.log(`   ⚠️  Insufficient approval: ${formatUnits(currentAllowance, collateralDecimals)}`)
        console.log(`   ⚠️  Required: ${formatUnits(targetSupplyWei, collateralDecimals)}`)
        console.log(`   📝 Approving Aave pool to spend tokens...`)
        
        // Approve the pool to spend tokens
        const approveHash = await walletClient.writeContract({
          address: collateralAsset,
          abi: erc20Abi,
          functionName: 'approve',
          args: [poolAddress, maxUint256],
        } as any)
        
        await publicClient.waitForTransactionReceipt({ hash: approveHash })
        console.log(`   ✅ Approved successfully (tx: ${approveHash})`)
      } else {
        console.log(`   ✅ Sufficient approval: ${formatUnits(currentAllowance, collateralDecimals)}`)
      }

      // Step 4: Supply collateral to reach target
      // Note: Aave supply adds to existing, so we need to calculate the difference
      // Since we can't easily get exact aToken balance, we'll use a strategy:
      // If we have existing collateral, try to withdraw all first, then supply target amount
      // Or supply the difference if we can calculate it
      console.log(`\n4️⃣ Supplying collateral to reach target...`)

      if (hasExistingPosition && totalCollateralBase > 0n) {
        // Try to withdraw all collateral first, then supply target amount
        // This ensures we end up with exactly the target amount
        try {
          console.log(`   📝 Withdrawing existing collateral first...`)
          const withdrawHash = await walletClient.writeContract({
            address: poolAddress,
            abi: AAVE_POOL_ABI,
            functionName: 'withdraw',
            args: [collateralAsset, maxUint256, accountAddress],
          } as any)
          await publicClient.waitForTransactionReceipt({ hash: withdrawHash })
          console.log(`   ✅ Withdrew existing collateral (tx: ${withdrawHash})`)
        } catch (e) {
          console.log(`   ⚠️  Could not withdraw existing collateral: ${e}`)
          console.log(`   📝 Will supply additional collateral (may exceed target)`)
        }
      }

      // Supply target amount
      const supplyHash = await walletClient.writeContract({
        address: poolAddress,
        abi: AAVE_POOL_ABI,
        functionName: 'supply',
        args: [collateralAsset, targetSupplyWei, accountAddress, 0],
      } as any)
      await publicClient.waitForTransactionReceipt({ hash: supplyHash })
      console.log(`   ✅ Supplied ${supplyAmount} tokens (tx: ${supplyHash})`)

      // Step 5: Borrow tokens to reach target
      if (targetBorrowWei > 0n) {
        console.log(`\n5️⃣ Borrowing tokens to reach target...`)
        
        // Check current debt after potential repayment
        const currentAccountData = await publicClient.readContract({
          address: poolAddress,
          abi: AAVE_POOL_ABI,
          functionName: 'getUserAccountData',
          args: [accountAddress],
        }) as [bigint, bigint, bigint, bigint, bigint, bigint]
        const [, currentDebt] = currentAccountData

        if (currentDebt < targetBorrowWei) {
          // Need to borrow more
          const borrowAmount = targetBorrowWei - currentDebt
          // Interest rate mode: 2 = variable
          const borrowHash = await walletClient.writeContract({
            address: poolAddress,
            abi: AAVE_POOL_ABI,
            functionName: 'borrow',
            args: [borrowAsset, borrowAmount, 2n, 0, accountAddress],
          } as any)
          await publicClient.waitForTransactionReceipt({ hash: borrowHash })
          console.log(`   ✅ Borrowed ${formatUnits(borrowAmount, borrowDecimals)} tokens (tx: ${borrowHash})`)
        } else if (currentDebt > targetBorrowWei) {
          // Need to repay excess
          const repayAmount = currentDebt - targetBorrowWei
          console.log(`   📝 Repaying excess debt: ${formatUnits(repayAmount, borrowDecimals)}`)
          const repayHash = await walletClient.writeContract({
            address: poolAddress,
            abi: AAVE_POOL_ABI,
            functionName: 'repay',
            args: [borrowAsset, repayAmount, 2n, accountAddress],
          } as any)
          await publicClient.waitForTransactionReceipt({ hash: repayHash })
          console.log(`   ✅ Repaid excess debt (tx: ${repayHash})`)
        } else {
          console.log(`   ✅ Debt already matches target`)
        }
      } else {
        // Target borrow is 0, repay all if exists
        const currentAccountData = await publicClient.readContract({
          address: poolAddress,
          abi: AAVE_POOL_ABI,
          functionName: 'getUserAccountData',
          args: [accountAddress],
        }) as [bigint, bigint, bigint, bigint, bigint, bigint]
        const [, currentDebt] = currentAccountData

        if (currentDebt > 0n) {
          console.log(`\n5️⃣ Repaying all debt (target is 0)...`)
          const repayHash = await walletClient.writeContract({
            address: poolAddress,
            abi: AAVE_POOL_ABI,
            functionName: 'repay',
            args: [borrowAsset, maxUint256, 2n, accountAddress],
          } as any)
          await publicClient.waitForTransactionReceipt({ hash: repayHash })
          console.log(`   ✅ Repaid all debt (tx: ${repayHash})`)
        } else {
          console.log(`\n5️⃣ Skipping borrow (target amount is 0 and no existing debt)`)
        }
      }

      console.log(`\n✅ Successfully set up Aave position on chain ${chainId}!`)

    } catch (error) {
      console.error(`\n❌ Error setting up position on chain ${chainId}:`, error)
      throw error
    }
  }

  console.log(`\n🎉 All positions set up successfully!\n`)
}

/**
 * Load configuration from JSON file or use defaults
 */
function loadConfig(): SetupConfig {

  // Use chains from config or defaults
  const chains: ChainConfig[] = (configData.chains || [
    {
      chainId: 42161, // Arbitrum
      supplyAmount: '500',
      borrowAmount: '100',
    },
    {
      chainId: 8453, // Base
      supplyAmount: '200',
      borrowAmount: '50',
    },
  ]).map((chain: any) => ({
    chainId: chain.chainId,
    supplyAmount: chain.supplyAmount,
    borrowAmount: chain.borrowAmount,
    collateralToken: chain.collateralToken && chain.collateralToken !== '' 
      ? (chain.collateralToken as Address) 
      : undefined,
    borrowToken: chain.borrowToken && chain.borrowToken !== ''
      ? (chain.borrowToken as Address)
      : undefined,
  }))

  return {
    chains,
  }
}

/**
 * Main execution function
 * 
 * Usage:
 *   npx hardhat run scripts/setupAavePositions.ts --network arbitrum
 *   npx hardhat run scripts/setupAavePositions.ts --network base
 * 
 * Configuration:
 *   - Edit scripts/aavePositionsConfig.json to configure amounts per chain
 *   - Uses the first account from Hardhat's configured accounts
 * 
 * Note: This script sets up positions on ONE chain at a time.
 * Run it multiple times with different --network flags for multiple chains.
 */
async function main() {
  const config = await loadConfig()
  
  // Connect to network to get chain ID
  const { viem } = await network.connect()
  const publicClient = await viem.getPublicClient()
  const currentChainId = publicClient.chain?.id
  
  if (!currentChainId) {
    throw new Error('Could not determine current chain ID from network')
  }

  const chainsForCurrentNetwork = config.chains.filter(chain => chain.chainId === currentChainId)
  
  if (chainsForCurrentNetwork.length === 0) {
    console.log(`⚠️  No configuration found for chain ${currentChainId}`)
    console.log(`   Available chains in config: ${config.chains.map(c => c.chainId).join(', ')}`)
    return
  }

  await setupAavePositions({
    ...config,
    chains: chainsForCurrentNetwork,
  })
}

// Run the script
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })

