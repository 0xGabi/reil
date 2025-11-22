import { formatUnits, erc20Abi, maxUint256 } from 'viem'
import {
  getNetworkClients,
  getAavePoolAddress,
  getUsdcAddress,
} from './helpers.js'

/**
 * Approve Aave pool to spend tokens from an account
 * 
 * Usage:
 *   npx hardhat run scripts/approveAavePool.ts --network arbitrum
 * 
 * Uses the first account from Hardhat's configured accounts
 */
async function main() {
  // Get network clients (uses Hardhat's configured accounts)
  const { publicClient, walletClient, accountAddress, chainId } = await getNetworkClients()

  // Get addresses for current chain
  const tokenAddress = getUsdcAddress(chainId)
  const poolAddress = getAavePoolAddress(chainId)

  console.log(`\n🔐 Approving Aave Pool`)
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  console.log(`Chain: ${chainId}`)
  console.log(`Account: ${accountAddress}`)
  console.log(`Token: ${tokenAddress}`)
  console.log(`Pool: ${poolAddress}\n`)

  // Check current allowance
  const currentAllowance = await publicClient.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [accountAddress, poolAddress],
  })

  const decimals = await publicClient.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'decimals',
  })

  console.log(`Current allowance: ${formatUnits(currentAllowance, decimals)}`)

  if (currentAllowance >= maxUint256 / 2n) {
    console.log(`✅ Already has sufficient approval`)
    return
  }

  // Approve
  console.log(`\nApproving...`)
  const hash = await walletClient.writeContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: 'approve',
    args: [poolAddress, maxUint256],
  } as any)

  console.log(`Transaction hash: ${hash}`)
  console.log(`Waiting for confirmation...`)

  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  console.log(`✅ Approved successfully!`)
  console.log(`   Block: ${receipt.blockNumber}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })

