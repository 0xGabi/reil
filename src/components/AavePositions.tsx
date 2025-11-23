import {
  Box,
  Button,
  CircularProgress,
  Typography,
  Alert,
  Stack,
  Tabs,
  Tab,
  Paper,
} from '@mui/material'
import { enqueueSnackbar } from 'notistack'
import { parseUnits } from 'viem'
import { type JSX, useEffect, useState, useCallback } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { CallbackType, type CrossChainSdk, type ExecCallback } from '@eil-protocol/sdk'
import { type AmbireMultiChainSmartAccount } from '@eil-protocol/accounts'
import { MultichainToken } from '@eil-protocol/sdk'

import {
  type AavePosition,
  fetchAavePositions,
  isPositionUnhealthy,
  rebalanceAavePositions,
  crossChainRebalanceAavePositions,
  createEilSdk,
} from '../provider/aave/index.ts'
import { getDeploymentChains } from '../provider/wagmiConfig.ts'
import { ChainNetwork } from './ChainNetwork.tsx'
import { RebalanceHistory, type RebalanceRecord } from './RebalanceHistory.tsx'

import DeployedTokensFile from '../../deployment/tokens.json'

const HEALTH_FACTOR_THRESHOLD = parseUnits('1.2', 18)
const REBALANCE_HISTORY_KEY = 'aave_rebalance_history'

function loadRebalanceHistory(): RebalanceRecord[] {
  try {
    const stored = localStorage.getItem(REBALANCE_HISTORY_KEY)
    if (stored) {
      return JSON.parse(stored)
    }
  } catch (e) {
    console.error('Failed to load rebalance history:', e)
  }
  return []
}

function saveRebalanceHistory(history: RebalanceRecord[]): void {
  try {
    // Keep only last 50 records
    const limited = history.slice(0, 50)
    localStorage.setItem(REBALANCE_HISTORY_KEY, JSON.stringify(limited))
  } catch (e) {
    console.error('Failed to save rebalance history:', e)
  }
}

function addRebalanceRecord(
  type: 'single-chain' | 'cross-chain',
  chains: number[],
  status: 'success' | 'failed' | 'pending',
  details?: string
): RebalanceRecord {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
    timestamp: Date.now(),
    type,
    chains,
    status,
    details,
  }
}

export function AavePositions(): JSX.Element {
  const [sdk, setSdk] = useState<CrossChainSdk | null>(null)
  const [sdkAccount, setSdkAccount] = useState<AmbireMultiChainSmartAccount | null>(null)
  const [, setCounter] = useState(0)
  const [rebalanceHistory, setRebalanceHistory] = useState<RebalanceRecord[]>(loadRebalanceHistory())
  const [activeTab, setActiveTab] = useState(0)

  const queryClient = useQueryClient()
  const [chainId0, chainId1, chainId2, chainId3] = getDeploymentChains()
  const chainIds: [number, number, number, number] = [chainId0, chainId1, chainId2, chainId3]

  // Construct MultichainToken instances
  const usdcToken: MultichainToken | undefined = sdk?.createToken('USDC', DeployedTokensFile.USDC)

  // Query Aave positions across chains
  const { data: positions, isFetching: isFetchingPositions, error: positionsError } = useQuery({
    queryKey: [
      'aavePositions',
      sdkAccount?.addressOn(BigInt(chainId0)),
      sdkAccount?.addressOn(BigInt(chainId1)),
      sdkAccount?.addressOn(BigInt(chainId2)),
      sdkAccount?.addressOn(BigInt(chainId3)),
    ],
    enabled: !!sdkAccount,
    refetchInterval: () => {
      // Only refetch when window is focused, and use a longer interval (60 seconds)
      // Return false to disable automatic refetching when window is not focused
      return document.hasFocus() ? 60000 : false
    },
    refetchOnWindowFocus: true, // Refetch when user returns to the window
    queryFn: async (): Promise<AavePosition[]> => {
      if (!sdkAccount) return []
      try {
        return await fetchAavePositions([chainId0, chainId1, chainId2, chainId3], sdkAccount)
      } catch (e) {
        console.error(e)
        return []
      }
    },
  })

  const updateRebalanceHistory = useCallback((record: RebalanceRecord) => {
    setRebalanceHistory((prev) => {
      // Check if a record with the same ID already exists
      const existingIndex = prev.findIndex((r) => r.id === record.id)
      let updated: RebalanceRecord[]
      
      if (existingIndex >= 0) {
        // Update existing record
        updated = [...prev]
        updated[existingIndex] = record
      } else {
        // Add new record at the beginning
        updated = [record, ...prev]
      }
      
      saveRebalanceHistory(updated)
      return updated
    })
  }, [])

  // Define callback function to observe the progress of UserOperations
  const callback: ExecCallback = ({ type, index, revertReason }) => {
    const chainId = chainIds[index] ?? 'unknown'
    console.log('action executed:', { type, index, chainId, revertReason })
    enqueueSnackbar(`Rebalancing executed on chain ${chainId} with status: ${type}`, {
      variant: 'info',
    })
    if (type === CallbackType.Done) {
      setCounter((prev) => {
        const newCounter = prev + 1
        const positionsLength = positions?.length ?? 0
        if (newCounter === positionsLength) {
          // All UserOps have completed successfully
          queryClient.invalidateQueries({ queryKey: ['aavePositions'] }).then()
          return 0
        }
        return newCounter
      })
    }
  }

  // Callback for cross-chain rebalancing (invalidates queries on each completion)
  const crossChainCallback: ExecCallback = ({ type, index, revertReason }) => {
    const chainId = chainIds[index] ?? 'unknown'
    console.log('cross-chain action executed:', { type, index, chainId, revertReason })
    enqueueSnackbar(`Cross-chain rebalancing on chain ${chainId}: ${type}`, { variant: 'info' })
    if (type === CallbackType.Done) {
      // Invalidate queries after each batch completes to show updated positions
      queryClient.invalidateQueries({ queryKey: ['aavePositions'] }).then()
    }
  }

  // Rebalance mutation (single-chain)
  const rebalanceMutation = useMutation({
    mutationFn: async () => {
      if (!sdk || !sdkAccount || !positions || !usdcToken) {
        throw new Error('SDK, account, positions, or tokens not available')
      }

      const unhealthyChains = positions
        .filter((pos) => isPositionUnhealthy(pos, HEALTH_FACTOR_THRESHOLD))
        .map((pos) => pos.chainId)

      // Add pending record
      const pendingRecord = addRebalanceRecord('single-chain', unhealthyChains, 'pending')
      updateRebalanceHistory(pendingRecord)

      try {
        await rebalanceAavePositions(sdk, sdkAccount, positions, usdcToken, usdcToken, callback)
        // Update to success
        const successRecord = { ...pendingRecord, status: 'success' as const }
        updateRebalanceHistory(successRecord)
      } catch (error) {
        // Update to failed
        const failedRecord = {
          ...pendingRecord,
          status: 'failed' as const,
          details: error instanceof Error ? error.message : 'Unknown error',
        }
        updateRebalanceHistory(failedRecord)
        throw error
      }
    },
    onSuccess: () => {
      enqueueSnackbar('Rebalancing successful!', { variant: 'success' })
      queryClient.invalidateQueries({ queryKey: ['aavePositions'] })
    },
    onError: (err: any) => {
      console.error(err)
      enqueueSnackbar(err?.message ?? 'Rebalancing failed', { variant: 'error' })
    },
  })

  // Cross-chain rebalance mutation
  const crossChainRebalanceMutation = useMutation({
    mutationFn: async () => {
      if (!sdk || !sdkAccount || !positions || !usdcToken) {
        throw new Error('SDK, account, positions, or tokens not available')
      }

      const unhealthyChains = positions
        .filter((pos) => isPositionUnhealthy(pos, HEALTH_FACTOR_THRESHOLD))
        .map((pos) => pos.chainId)
      const healthyChains = positions
        .filter((pos) => !isPositionUnhealthy(pos, HEALTH_FACTOR_THRESHOLD) && pos.totalCollateralBase > 0n)
        .map((pos) => pos.chainId)
      const allChains = [...new Set([...unhealthyChains, ...healthyChains])]

      // Add pending record
      const pendingRecord = addRebalanceRecord('cross-chain', allChains, 'pending')
      updateRebalanceHistory(pendingRecord)

      try {
        await crossChainRebalanceAavePositions(
          sdk,
          sdkAccount,
          positions,
          usdcToken,
          crossChainCallback,
          HEALTH_FACTOR_THRESHOLD
        )
        // Update to success
        const successRecord = { ...pendingRecord, status: 'success' as const }
        updateRebalanceHistory(successRecord)
      } catch (error) {
        // Update to failed
        const failedRecord = {
          ...pendingRecord,
          status: 'failed' as const,
          details: error instanceof Error ? error.message : 'Unknown error',
        }
        updateRebalanceHistory(failedRecord)
        throw error
      }
    },
    onSuccess: () => {
      enqueueSnackbar('Cross-chain rebalancing successful!', { variant: 'success' })
      queryClient.invalidateQueries({ queryKey: ['aavePositions'] })
    },
    onError: (err: any) => {
      console.error(err)
      enqueueSnackbar(err?.message ?? 'Cross-chain rebalancing failed', { variant: 'error' })
    },
  })

  // Build the EIL SDK and Multi-Chain Account instances
  useEffect(() => {
    let cancelled = false

    async function fetchSdk() {
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

  // Show error message if any query function throws an error
  useEffect(() => {
    if (positionsError) {
      enqueueSnackbar((positionsError as Error).message ?? 'Failed to fetch Aave positions', {
        variant: 'error',
      })
    }
  }, [positionsError])

  if (sdk == null) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="400px">
        <Typography>Please connect to an injected wallet.</Typography>
      </Box>
    )
  }

  if (isFetchingPositions) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="400px">
        <CircularProgress />
      </Box>
    )
  }

  const unhealthyPositions = positions?.filter((pos) => isPositionUnhealthy(pos, HEALTH_FACTOR_THRESHOLD)) ?? []
  const healthyPositions =
    positions?.filter((pos) => !isPositionUnhealthy(pos, HEALTH_FACTOR_THRESHOLD) && pos.totalCollateralBase > 0n) ??
    []
  const hasUnhealthyPositions = unhealthyPositions.length > 0
  const hasHealthyPositions = healthyPositions.length > 0
  const canCrossChainRebalance = hasUnhealthyPositions && hasHealthyPositions && positions && positions.length >= 2

  return (
    <Box sx={{ p: 3, maxWidth: '1400px', width: '100%' }}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Automatically rebalance your Aave lending positions across Ethereum, Optimism, Arbitrum, and Base
        to maintain optimal health factors and reduce liquidation risk.
      </Typography>

      <Paper sx={{ mb: 3 }}>
        <Tabs value={activeTab} onChange={(_, newValue) => setActiveTab(newValue)}>
          <Tab label="Positions Overview" />
          <Tab label="Rebalance History" />
        </Tabs>
      </Paper>

      {activeTab === 0 && (
        <Box>
          {hasUnhealthyPositions && (
            <Alert severity="warning" sx={{ mb: 3 }}>
              <Typography variant="body1" fontWeight="bold">
                ⚠️ Warning: {unhealthyPositions.length} position(s) have unhealthy health factors
              </Typography>
              <Typography variant="body2" sx={{ mt: 1 }}>
                Consider rebalancing to improve your position health and avoid liquidation risk.
                {canCrossChainRebalance && (
                  <>
                    {' '}
                    You can use cross-chain rebalancing to transfer collateral from healthy positions
                    on other chains.
                  </>
                )}
              </Typography>
            </Alert>
          )}

          {positions && positions.length === 0 && (
            <Alert severity="info" sx={{ mb: 3 }}>
              No Aave positions found on the configured chains. You may need to create positions first.
            </Alert>
          )}

          <ChainNetwork positions={positions ?? []} chainIds={chainIds} />

          <Box sx={{ mt: 3 }}>
            <Typography variant="h6" gutterBottom>
              Rebalancing Actions
            </Typography>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mt: 2 }}>
              {hasUnhealthyPositions && (
                <Button
                  variant="contained"
                  color="warning"
                  size="large"
                  onClick={() => rebalanceMutation.mutate()}
                  disabled={rebalanceMutation.isPending || crossChainRebalanceMutation.isPending || !usdcToken}
                  startIcon={rebalanceMutation.isPending ? <CircularProgress size={20} /> : undefined}
                  sx={{ minWidth: 250, py: 1.5 }}
                >
                  {rebalanceMutation.isPending
                    ? 'Rebalancing...'
                    : 'Rebalance (Single-Chain)'}
                </Button>
              )}
              {canCrossChainRebalance && (
                <Button
                  variant="contained"
                  color="primary"
                  size="large"
                  onClick={() => crossChainRebalanceMutation.mutate()}
                  disabled={rebalanceMutation.isPending || crossChainRebalanceMutation.isPending || !usdcToken}
                  startIcon={crossChainRebalanceMutation.isPending ? <CircularProgress size={20} /> : undefined}
                  sx={{ minWidth: 250, py: 1.5 }}
                >
                  {crossChainRebalanceMutation.isPending
                    ? 'Cross-Chain Rebalancing...'
                    : '🚀 Cross-Chain Rebalance'}
                </Button>
              )}
            </Stack>
          </Box>

          {!hasUnhealthyPositions && positions && positions.length > 0 && (
            <Alert severity="success" sx={{ mt: 3 }}>
              ✅ All positions are healthy! No rebalancing needed.
            </Alert>
          )}
        </Box>
      )}

      {activeTab === 1 && (
        <Box>
          <RebalanceHistory history={rebalanceHistory} />
        </Box>
      )}
    </Box>
  )
}
