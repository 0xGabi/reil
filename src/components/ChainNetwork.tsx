import {
  Box,
  Card,
  CardContent,
  Typography,
  Chip,
  LinearProgress,
  Avatar,
} from '@mui/material'
import { formatUnits } from 'viem'
import { type JSX } from 'react'
import { type AavePosition } from '../provider/aave/index.ts'

interface ChainNetworkProps {
  positions: AavePosition[]
  chainIds: [number, number, number, number]
  onChainClick?: (chainId: number) => void
}

const CHAIN_NAMES: Record<number, string> = {
  1: 'Ethereum',
  10: 'Optimism',
  42161: 'Arbitrum',
  8453: 'Base',
}

const CHAIN_COLORS: Record<number, string> = {
  1: '#627EEA',
  10: '#FF0420',
  42161: '#28A0F0',
  8453: '#0052FF',
}

const HEALTH_FACTOR_THRESHOLD = 1.2

export function ChainNetwork({ positions, chainIds, onChainClick }: ChainNetworkProps): JSX.Element {
  const formatHealthFactor = (hf: bigint): string => {
    if (hf === 0n) return '∞'
    const hfStr = formatUnits(hf, 18)
    // Parse as float and ensure we always get exactly 2 decimal places
    // Using parseFloat and toFixed ensures no scientific notation
    const hfNum = parseFloat(hfStr)
    if (isNaN(hfNum) || !isFinite(hfNum)) return '0.00'
    return hfNum.toFixed(2)
  }

  const getHealthFactorColor = (hf: bigint): 'success' | 'warning' | 'error' => {
    if (hf === 0n) return 'success'
    const hfNum = Number(formatUnits(hf, 18))
    if (hfNum >= 2.0) return 'success'
    if (hfNum >= HEALTH_FACTOR_THRESHOLD) return 'warning'
    return 'error'
  }

  const getHealthFactorProgress = (hf: bigint): number => {
    if (hf === 0n) return 100
    const hfNum = Number(formatUnits(hf, 18))
    return Math.min(100, Math.max(0, ((hfNum - 1.0) / 2.0) * 100))
  }

  const getPositionForChain = (chainId: number): AavePosition | undefined => {
    return positions.find((p) => p.chainId === chainId)
  }

  const chainCards = chainIds.map((chainId) => {
    const position = getPositionForChain(chainId)
    const chainName = CHAIN_NAMES[chainId] || `Chain ${chainId}`
    const chainColor = CHAIN_COLORS[chainId] || '#666'

    return (
      <Card
        key={chainId}
        variant="outlined"
        sx={{
          flex: 1,
          minWidth: { xs: '100%', sm: '200px', md: '220px' },
          cursor: onChainClick ? 'pointer' : 'default',
          transition: 'all 0.2s',
          borderColor: position
            ? getHealthFactorColor(position.healthFactor) === 'error'
              ? 'error.main'
              : getHealthFactorColor(position.healthFactor) === 'warning'
                ? 'warning.main'
                : 'divider'
            : 'divider',
          borderWidth: position && getHealthFactorColor(position.healthFactor) === 'error' ? 2 : 1,
          '&:hover': onChainClick
            ? {
                transform: 'translateY(-2px)',
                boxShadow: 2,
              }
            : {},
        }}
        onClick={() => onChainClick?.(chainId)}
      >
        <CardContent sx={{ p: 2.5, '&:last-child': { pb: 2.5 } }}>
          <Box display="flex" alignItems="center" gap={1.5} mb={2.5}>
            <Avatar
              sx={{
                bgcolor: chainColor,
                width: 40,
                height: 40,
                fontWeight: 'bold',
                fontSize: '1rem',
              }}
            >
              {chainName[0]}
            </Avatar>
            <Box flex={1}>
              <Typography variant="subtitle1" fontWeight="bold" lineHeight={1.3}>
                {chainName}
              </Typography>
              <Typography variant="caption" color="text.secondary" fontSize="0.75rem">
                Chain ID: {chainId}
              </Typography>
            </Box>
            {position && (
              <Chip
                label={formatHealthFactor(position.healthFactor)}
                color={getHealthFactorColor(position.healthFactor)}
                size="small"
                sx={{ height: 24, fontSize: '0.75rem', fontWeight: 'bold' }}
              />
            )}
          </Box>

          {position ? (
            <>
              <LinearProgress
                variant="determinate"
                value={getHealthFactorProgress(position.healthFactor)}
                color={getHealthFactorColor(position.healthFactor)}
                sx={{ height: 8, borderRadius: 2, mb: 2 }}
              />

              <Box display="flex" justifyContent="space-between" gap={1} mb={1.5}>
                <Typography variant="body2" color="text.secondary" fontSize="0.8rem">
                  Collateral
                </Typography>
                <Typography variant="body2" fontWeight="bold" fontSize="0.85rem">
                  ${Number(formatUnits(position.totalCollateralBase, 8)).toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </Typography>
              </Box>

              <Box display="flex" justifyContent="space-between" gap={1} mb={1.5}>
                <Typography variant="body2" color="text.secondary" fontSize="0.8rem">
                  Debt
                </Typography>
                <Typography
                  variant="body2"
                  fontWeight="bold"
                  fontSize="0.85rem"
                  color={position.totalDebtBase > 0n ? 'error.main' : 'text.primary'}
                >
                  ${Number(formatUnits(position.totalDebtBase, 8)).toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </Typography>
              </Box>

              <Box display="flex" justifyContent="space-between" gap={1}>
                <Typography variant="body2" color="text.secondary" fontSize="0.8rem">
                  Available
                </Typography>
                <Typography variant="body2" color="success.main" fontWeight="bold" fontSize="0.85rem">
                  ${Number(formatUnits(position.availableBorrowsBase, 8)).toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </Typography>
              </Box>
            </>
          ) : (
            <Box textAlign="center" py={2}>
              <Typography variant="body2" color="text.secondary" fontSize="0.8rem">
                No position
              </Typography>
            </Box>
          )}
        </CardContent>
      </Card>
    )
  })

  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: {
          xs: '1fr',
          sm: 'repeat(2, 1fr)',
          md: 'repeat(4, 1fr)',
        },
        gap: 2,
      }}
    >
      {chainCards}
    </Box>
  )
}

