import {
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Typography,
  Alert,
  Chip,
  LinearProgress,
  Stack,
} from '@mui/material'
import { enqueueSnackbar } from 'notistack'
import { formatUnits, parseUnits } from 'viem'
import { type JSX, useEffect, useState } from 'react'
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
} from '../provider/aave/aave.ts'
import { createEilSdk } from '../provider/flags/flags.ts'
import { getDeploymentChains } from '../provider/wagmiConfig.ts'

import DeployedTokensFile from '../../deployment/tokens.json'

const HEALTH_FACTOR_THRESHOLD = parseUnits('1.5', 18)

export function AavePositions(): JSX.Element {
  const [sdk, setSdk] = useState<CrossChainSdk | null>(null)
  const [sdkAccount, setSdkAccount] = useState<AmbireMultiChainSmartAccount | null>(null)
  const [, setCounter] = useState(0)

  const queryClient = useQueryClient()
  const [chainId0, chainId1] = getDeploymentChains()

  // Construct MultichainToken instances
  const usdcToken: MultichainToken | undefined = sdk?.createToken('USDC', DeployedTokensFile.USDC)
  // For WETH, we'll use USDC as both collateral and debt token for simplicity
  // In a real scenario, you'd want to support different token pairs

  // Query Aave positions across chains
  const { data: positions, isFetching: isFetchingPositions, error: positionsError } = useQuery({
    queryKey: ['aavePositions', sdkAccount?.addressOn(BigInt(chainId0)), sdkAccount?.addressOn(BigInt(chainId1))],
    enabled: !!sdkAccount,
    refetchInterval: 30000, // Refetch every 30 seconds
    queryFn: async (): Promise<AavePosition[]> => {
      if (!sdkAccount) return []
      try {
        return await fetchAavePositions([chainId0, chainId1], sdkAccount)
      } catch (e) {
        console.error(e)
        return []
      }
    }
  })

  // Define callback function to observe the progress of UserOperations
  const callback: ExecCallback = ({ type, index, revertReason }) => {
    const chainId = [chainId0, chainId1][index] ?? 'unknown'
    console.log('action executed:', { type, index, chainId, revertReason })
    enqueueSnackbar(`Rebalancing executed on chain ${chainId} with status: ${type}`, { variant: 'info' })
    if (type === CallbackType.Done) {
      setCounter(prev => {
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
    const chainId = [chainId0, chainId1][index] ?? 'unknown'
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
      await rebalanceAavePositions(sdk, sdkAccount, positions, usdcToken, usdcToken, callback)
    },
    onSuccess: () => {
      enqueueSnackbar('Rebalancing successful!', { variant: 'success' })
      queryClient.invalidateQueries({ queryKey: ['aavePositions'] })
    },
    onError: (err: any) => {
      console.error(err)
      enqueueSnackbar(err?.message ?? 'Rebalancing failed', { variant: 'error' })
    }
  })

  // Cross-chain rebalance mutation
  const crossChainRebalanceMutation = useMutation({
    mutationFn: async () => {
      if (!sdk || !sdkAccount || !positions || !usdcToken) {
        throw new Error('SDK, account, positions, or tokens not available')
      }
      await crossChainRebalanceAavePositions(
        sdk,
        sdkAccount,
        positions,
        usdcToken,
        crossChainCallback,
        HEALTH_FACTOR_THRESHOLD,
        parseUnits('2.0', 18)
      )
    },
    onSuccess: () => {
      enqueueSnackbar('Cross-chain rebalancing successful!', { variant: 'success' })
      queryClient.invalidateQueries({ queryKey: ['aavePositions'] })
    },
    onError: (err: any) => {
      console.error(err)
      enqueueSnackbar(err?.message ?? 'Cross-chain rebalancing failed', { variant: 'error' })
    }
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
  const healthyPositions = positions?.filter((pos) => !isPositionUnhealthy(pos, HEALTH_FACTOR_THRESHOLD) && pos.totalCollateralBase > 0n) ?? []
  const hasUnhealthyPositions = unhealthyPositions.length > 0
  const hasHealthyPositions = healthyPositions.length > 0
  const canCrossChainRebalance = hasUnhealthyPositions && hasHealthyPositions && positions && positions.length >= 2

  const formatHealthFactor = (hf: bigint): string => {
    if (hf === 0n) return '∞ (No Debt)'
    return Number(formatUnits(hf, 18)).toFixed(4)
  }

  const getHealthFactorColor = (hf: bigint): 'success' | 'warning' | 'error' => {
    if (hf === 0n) return 'success'
    const hfNum = Number(formatUnits(hf, 18))
    if (hfNum >= 2.0) return 'success'
    if (hfNum >= 1.5) return 'warning'
    return 'error'
  }

  const getHealthFactorProgress = (hf: bigint): number => {
    if (hf === 0n) return 100
    const hfNum = Number(formatUnits(hf, 18))
    // Normalize to 0-100 scale, where 1.0 = 0% and 3.0 = 100%
    return Math.min(100, Math.max(0, ((hfNum - 1.0) / 2.0) * 100))
  }

  return (
    <Box sx={{ p: 3 }}>
      <Typography variant="h4" gutterBottom>
        Aave Position Manager
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
        Monitor and rebalance your Aave positions across multiple chains
      </Typography>

      {hasUnhealthyPositions && (
        <Alert severity="warning" sx={{ mb: 3 }}>
          <Typography variant="body1" fontWeight="bold">
            Warning: {unhealthyPositions.length} position(s) have unhealthy health factors
          </Typography>
          <Typography variant="body2">
            Consider rebalancing to improve your position health and avoid liquidation risk.
            {canCrossChainRebalance && (
              <> You can use cross-chain rebalancing to transfer collateral from healthy positions.</>
            )}
          </Typography>
        </Alert>
      )}

      {positions && positions.length === 0 && (
        <Alert severity="info" sx={{ mb: 3 }}>
          No Aave positions found on the configured chains. You may need to create positions first.
        </Alert>
      )}

      <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} sx={{ mb: 3 }}>
        {positions?.map((position) => {
          const isUnhealthy = isPositionUnhealthy(position, HEALTH_FACTOR_THRESHOLD)

          return (
            <Box key={`${position.chainId}-${position.userAddress}`} sx={{ flex: 1, minWidth: { xs: '100%', md: '300px' } }}>
              <Card
                variant="outlined"
                sx={{
                  height: '100%',
                  borderColor: isUnhealthy ? 'error.main' : 'divider',
                  borderWidth: isUnhealthy ? 2 : 1,
                }}
              >
                <CardContent>
                  <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
                    <Typography variant="h6">Chain {position.chainId}</Typography>
                    <Chip
                      label={`HF: ${formatHealthFactor(position.healthFactor)}`}
                      color={getHealthFactorColor(position.healthFactor)}
                      size="small"
                    />
                  </Box>

                  <Box mb={2}>
                    <Typography variant="body2" color="text.secondary" gutterBottom>
                      Health Factor Progress
                    </Typography>
                    <LinearProgress
                      variant="determinate"
                      value={getHealthFactorProgress(position.healthFactor)}
                      color={getHealthFactorColor(position.healthFactor)}
                      sx={{ height: 8, borderRadius: 4 }}
                    />
                  </Box>

                  <Box mb={2}>
                    <Typography variant="body2" color="text.secondary">
                      Total Collateral (USD)
                    </Typography>
                    <Typography variant="h6">
                      ${Number(formatUnits(position.totalCollateralBase, 8)).toFixed(2)}
                    </Typography>
                  </Box>

                  <Box mb={2}>
                    <Typography variant="body2" color="text.secondary">
                      Total Debt (USD)
                    </Typography>
                    <Typography variant="h6" color={position.totalDebtBase > 0n ? 'error.main' : 'text.primary'}>
                      ${Number(formatUnits(position.totalDebtBase, 8)).toFixed(2)}
                    </Typography>
                  </Box>

                  <Box mb={2}>
                    <Typography variant="body2" color="text.secondary">
                      Available Borrows (USD)
                    </Typography>
                    <Typography variant="h6" color="success.main">
                      ${Number(formatUnits(position.availableBorrowsBase, 8)).toFixed(2)}
                    </Typography>
                  </Box>

                  <Box mb={2}>
                    <Typography variant="body2" color="text.secondary">
                      LTV / Liquidation Threshold
                    </Typography>
                    <Typography variant="body1">
                      {Number(formatUnits(position.ltv, 4))}% /{' '}
                      {Number(formatUnits(position.currentLiquidationThreshold, 4))}%
                    </Typography>
                  </Box>

                  <Box>
                    <Typography variant="body2" color="text.secondary" noWrap>
                      Account: {position.userAddress.slice(0, 6)}...{position.userAddress.slice(-4)}
                    </Typography>
                  </Box>
                </CardContent>
              </Card>
            </Box>
          )
        })}
      </Stack>

      {hasUnhealthyPositions && (
        <Box display="flex" justifyContent="center" gap={2} mt={3} flexWrap="wrap">
          <Button
            variant="contained"
            color="warning"
            size="large"
            onClick={() => rebalanceMutation.mutate()}
            disabled={rebalanceMutation.isPending || crossChainRebalanceMutation.isPending || !usdcToken}
            startIcon={rebalanceMutation.isPending ? <CircularProgress size={20} /> : undefined}
            sx={{ minWidth: 200 }}
          >
            {rebalanceMutation.isPending ? 'Rebalancing...' : 'Rebalance Positions (Single-Chain)'}
          </Button>
          {canCrossChainRebalance && (
            <Button
              variant="contained"
              color="info"
              size="large"
              onClick={() => crossChainRebalanceMutation.mutate()}
              disabled={rebalanceMutation.isPending || crossChainRebalanceMutation.isPending || !usdcToken}
              startIcon={crossChainRebalanceMutation.isPending ? <CircularProgress size={20} /> : undefined}
              sx={{ minWidth: 200 }}
            >
              {crossChainRebalanceMutation.isPending ? 'Cross-Chain Rebalancing...' : 'Cross-Chain Rebalance'}
            </Button>
          )}
        </Box>
      )}

      {!hasUnhealthyPositions && positions && positions.length > 0 && (
        <Alert severity="success" sx={{ mt: 3 }}>
          All positions are healthy! No rebalancing needed.
        </Alert>
      )}
    </Box>
  )
}

