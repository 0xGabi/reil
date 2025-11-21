import { Button, CircularProgress, TextField } from '@mui/material'
import { enqueueSnackbar } from 'notistack'
import { formatEther, formatUnits, parseUnits } from 'viem'
import { type JSX, useEffect, useState } from 'react'
import { type SmartAccount } from 'viem/account-abstraction'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { CallbackType, type CrossChainSdk, type ExecCallback, MultichainToken } from '@eil-protocol/sdk'
import { type AmbireMultiChainSmartAccount } from '@eil-protocol/accounts'

import {
  type BalanceData,
  type CapturedFlagsData,
  captureFlags,
  captureFlagsWithTransfer,
  captureFlagsWithTransferAndDynamicVariable,
  createEilSdk,
  fetchCapturedFlags,
  fetchTokenBalances,
  sudoMint,
} from '../provider/flags/flags.ts'

import { BALANCE_PLACEHOLDER } from '../utils/constants.ts'

import DeployedTokensFile from '../../deployment/tokens.json'
import { getDeploymentChains } from '../provider/wagmiConfig.ts'

export function Flags (): JSX.Element {
  const [newHolderName, setNewHolderName] = useState('')
  const [transferAmount, setTransferAmount] = useState('')
  const [sdk, setSdk] = useState<CrossChainSdk | null>(null)
  const [sdkAccount, setSdkAccount] = useState<AmbireMultiChainSmartAccount | null>(null)
  const [, setCounter] = useState(0)

  const queryClient = useQueryClient()
  const [chainId0, chainId1] = getDeploymentChains()

  // constructing a MultichainToken instance from the JSON deployment file
  const eilUsdc: MultichainToken | undefined = sdk?.createToken('USDC', DeployedTokensFile.USDC)
  const account0: SmartAccount | undefined = sdkAccount?.contractOn(BigInt(chainId0))
  const account1: SmartAccount | undefined = sdkAccount?.contractOn(BigInt(chainId1))

  // query both chains for the current flag holder
  const { data: flagsData, isFetching: isFetchingFlags, error: flagsError } = useQuery({
    queryKey: ['flags'],
    initialData: { flagHolder0: 'n/a', flagHolder1: 'n/a' },
    queryFn: async (): Promise<CapturedFlagsData | undefined> => {
      try {
        return await fetchCapturedFlags([chainId0, chainId1])
      } catch (e) {
        console.error(e)
      }
    }
  })

  // query both chains for the current flag USDC balances
  const { data: balances, isFetching: isFetchingBalances, error: balancesError } = useQuery({
    queryKey: ['balances', sdkAccount?.addressOn(BigInt(chainId0)) ?? '', sdkAccount?.addressOn(BigInt(chainId1)) ?? ''],
    initialData: BALANCE_PLACEHOLDER,
    queryFn: async (): Promise<BalanceData | undefined> => {
      try {
        console.log('fetching balances', eilUsdc, sdkAccount)
        return await fetchTokenBalances([chainId0, chainId1], eilUsdc!, sdkAccount!)
      } catch (e) {
        console.error(e)
        return BALANCE_PLACEHOLDER
      }
    }
  })

  // define a callback function to observe the progress of the Multi-Chain UserOperations in the EIL SDK
  const callback: ExecCallback = ({ type, index, revertReason }) => {
    const chainId = [chainId0, chainId1][index] ?? 'unknown'
    console.log('action executed:', { type, index, chainId, revertReason })
    enqueueSnackbar(`Cross-chain action executed on chain ${chainId} with status: ${type}`, { variant: 'info' })
    if (type === CallbackType.Done) {
      setCounter(prev => {
        const newCounter = prev + 1
        if (newCounter === 2) {
          // Both UserOps have completed successfully.
          // Invalidate and refetch all queries.
          queryClient.invalidateQueries({ queryKey: ['flags'] }).then()
          queryClient.invalidateQueries({ queryKey: ['balances'] }).then()
          return 0
        }
        return newCounter
      })
    }
  }

  // initiate both "Capture The Flag" UserOperations on both chains
  const captureFlagsMutation = useMutation({
    mutationFn: async () => {
      if (!sdk || !sdkAccount) throw new Error('SDK not available')
      await captureFlags(sdk, sdkAccount, newHolderName, callback)
    },
    onSuccess: () => {
      enqueueSnackbar('Success!', { variant: 'success' })
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onError: (err: any) => {
      console.error(err)
      enqueueSnackbar(err?.message ?? 'Something went wrong', { variant: 'error' })
    }
  })

  // initiate both "Capture The Flag" UserOperations on both chains with the asset transfer
  const captureFlagsWithTransferMutation = useMutation({
    mutationFn: async () => {
      console.log('captureFlagsWithTransferMutation', newHolderName, transferAmount)
      if (!sdk) throw new Error('SDK not available')
      if (!transferAmount) throw new Error('Transfer amount is required')
      const amountInWei = parseUnits(transferAmount, 6)
      return await captureFlagsWithTransfer(sdk, sdkAccount!, newHolderName, eilUsdc!, amountInWei, callback)
    },
    onSuccess: () => {
      enqueueSnackbar('Success!', { variant: 'success' })
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onError: (err: any) => {
      console.error(err)
      enqueueSnackbar(err?.message ?? 'Something went wrong', { variant: 'error' })
    }
  })

  // initiate both "Capture The Flag" UserOperations on both chains with the asset transfer and dynamic variable usage
  const captureFlagsWithTransferAndDynamicVariableMutation = useMutation({
    mutationFn: async () => {
      if (!sdk) throw new Error('SDK not available')
      await captureFlagsWithTransferAndDynamicVariable(sdk, newHolderName, eilUsdc!, callback)
    },
    onSuccess: () => {
      enqueueSnackbar('Success!', { variant: 'success' })
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onError: (err: any) => {
      console.error(err)
      enqueueSnackbar(err?.message ?? 'Something went wrong', { variant: 'error' })
    }
  })

  const sudoMintMutation = useMutation({
    mutationFn: async () => {
      if (!account0?.address) throw new Error('Account not available')
      await sudoMint(chainId0, eilUsdc!, account0.address, () => {
        // Invalidate and refetch queries after minting
        queryClient.invalidateQueries({ queryKey: ['flags'] })
        queryClient.invalidateQueries({ queryKey: ['balances'] })
      })
    },
    onSuccess: () => {
      enqueueSnackbar('Minting successful!', { variant: 'success' })
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onError: (err: any) => {
      console.error(err)
      enqueueSnackbar(err?.message ?? 'Minting failed', { variant: 'error' })
    }
  })

  // show the error message if any query function throws an error
  useEffect(() => {
    const error = flagsError ?? balancesError
    console.log('useEffect error', error)
    if (error) {
      enqueueSnackbar((error as Error).message ?? 'Failed to fetch balances', {
        variant: 'error',
      })
    }
  }, [flagsError, balancesError])

  // build the EIL SDK and Multi-Chain Account instances
  useEffect(() => {
    let cancelled = false

    async function fetchSdk () {
      try {
        const { sdk, account } = await createEilSdk()
        if (!cancelled) {
          setSdk(sdk)
          setSdkAccount(account)
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to initialize SDK:', error)
          enqueueSnackbar('Failed to initialize SDK', { variant: 'error' })
        }
      }
    }

    fetchSdk().then()

    return () => {
      cancelled = true
    }
  }, [])

  // Check if any mutation is pending
  const isAnyMutationPending = captureFlagsMutation.isPending ||
    captureFlagsWithTransferMutation.isPending ||
    captureFlagsWithTransferAndDynamicVariableMutation.isPending ||
    sudoMintMutation.isPending

  // Calculate total USDC balance across both chains
  const totalUsdcBalance = (balances?.balance0 ?? 0n) + (balances?.balance1 ?? 0n)
  const totalUsdcBalanceFormatted = Number(formatUnits(totalUsdcBalance, 6))

  // Validate transfer amount
  const transferAmountNum = transferAmount ? parseFloat(transferAmount) : 0
  const isTransferAmountValid = transferAmount &&
    transferAmountNum > 0 &&
    transferAmountNum <= totalUsdcBalanceFormatted

  if (sdk == null) {
    return <p>There is no connected account. Please connect to an injected wallet.</p>
  }

  if (isFetchingFlags || isFetchingBalances) {
    return <p>Loading...</p>
  }

  // using the chainID 10 as a flag that this is actually running on anvil in the test docker
  if (chainId0 === 10 && balances?.balanceEth0 === 0n) {
    return <div>
      <p>Please mint the USDC and ETH for the origin account first.</p>
      <Button
        onClick={() => sudoMintMutation.mutate()}
        disabled={sudoMintMutation.isPending}
        startIcon={sudoMintMutation.isPending ? <CircularProgress size={20}/> : undefined}
      >
        {sudoMintMutation.isPending ? 'Minting...' : 'SUDO MINT'}
      </Button>
    </div>
  }

  return (
    <div>
      <p>ChainID: {chainId0}</p>
      <p>Account {account0?.address}</p>
      <p>Flag Holder: {flagsData?.flagHolder0}</p>
      <p>Balance: {formatUnits(balances?.balance0 ?? -1n, 6)} USDC</p>
      <p>Balance: {formatEther(balances?.balanceEth0 ?? -1n)} ETH</p>
      <br/>
      <p>ChainID: {chainId1}</p>
      <p>Account: {account1?.address}</p>
      <p>Flag Holder: {flagsData?.flagHolder1}</p>
      <p>Balance: {formatUnits(balances?.balance1 ?? -1n, 6)} USDC</p>
      <p>Balance: {formatEther(balances?.balanceEth1 ?? -1n)} ETH</p>
      <br/>
      <p>Total USDC Balance: {totalUsdcBalanceFormatted} USDC</p>
      <br/><br/>
      <TextField
        type="text"
        value={newHolderName}
        onChange={e => setNewHolderName(e.target.value)}
        placeholder="Enter Your Name"
        label="Name"
        variant="outlined"
        fullWidth
        color="primary"
        style={{ marginBottom: '16px' }}
      />
      <TextField
        type="number"
        value={transferAmount}
        onChange={e => setTransferAmount(e.target.value)}
        placeholder="Enter USDC amount"
        label="USDC Transfer Amount"
        variant="outlined"
        fullWidth
        color="primary"
        slotProps={{
          htmlInput: {
            min: 0,
            max: totalUsdcBalanceFormatted,
            step: 0.000001
          }
        }}
        error={Boolean(transferAmount && !isTransferAmountValid)}
        helperText={
          transferAmount && !isTransferAmountValid
            ? transferAmountNum <= 0
              ? 'Amount must be greater than 0'
              : `Amount exceeds total balance (${totalUsdcBalanceFormatted} USDC)`
            : ''
        }
        style={{ marginBottom: '16px' }}
      />
      <Button
        onClick={() => captureFlagsMutation.mutate()}
        disabled={isAnyMutationPending}
        startIcon={captureFlagsMutation.isPending ? <CircularProgress size={20}/> : undefined}
        style={{ marginBottom: '8px', display: 'block' }}
      >
        {captureFlagsMutation.isPending ? 'Capturing...' : 'Capture Flags'}
      </Button>
      <Button
        onClick={() => captureFlagsWithTransferMutation.mutate()}
        disabled={isAnyMutationPending || !isTransferAmountValid}
        startIcon={captureFlagsWithTransferMutation.isPending ? <CircularProgress size={20}/> : undefined}
        style={{ marginBottom: '8px', display: 'block' }}
      >
        {captureFlagsWithTransferMutation.isPending ? 'Capturing...' : 'Capture Flags With Transfer'}
      </Button>
      <Button
        onClick={() => captureFlagsWithTransferAndDynamicVariableMutation.mutate()}
        disabled={isAnyMutationPending}
        startIcon={captureFlagsWithTransferAndDynamicVariableMutation.isPending ? <CircularProgress
          size={20}/> : undefined}
        style={{ marginBottom: '8px', display: 'block' }}
      >
        {captureFlagsWithTransferAndDynamicVariableMutation.isPending ? 'Capturing...' : 'Capture Flags With Transfer And Dynamic Variable'}
      </Button>
    </div>
  )
}
