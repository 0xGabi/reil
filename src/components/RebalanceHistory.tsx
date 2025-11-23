import {
  Box,
  Card,
  CardContent,
  Typography,
  Chip,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Avatar,
  Tooltip,
} from '@mui/material'
import { type JSX } from 'react'
import { getChainName, getChainColor } from '../config/networks.ts'

export interface RebalanceRecord {
  id: string
  timestamp: number
  type: 'single-chain' | 'cross-chain'
  chains: number[]
  status: 'success' | 'failed' | 'pending'
  details?: string
}

interface RebalanceHistoryProps {
  history: RebalanceRecord[]
}

export function RebalanceHistory({ history }: RebalanceHistoryProps): JSX.Element {
  const formatDate = (timestamp: number): string => {
    const date = new Date(timestamp)
    return date.toLocaleString()
  }

  const getChainAvatar = (chainId: number): JSX.Element => {
    return (
      <Avatar
        sx={{
          width: 24,
          height: 24,
          bgcolor: getChainColor(chainId),
          fontSize: '0.75rem',
          fontWeight: 'bold',
        }}
      >
        {getChainName(chainId)[0] || '?'}
      </Avatar>
    )
  }

  if (history.length === 0) {
    return (
      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Rebalance History
          </Typography>
          <Box sx={{ textAlign: 'center', py: 4 }}>
            <Typography variant="body2" color="text.secondary">
              No rebalances yet. Start rebalancing your positions to see history here.
            </Typography>
          </Box>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Rebalance History
        </Typography>
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Time</TableCell>
                <TableCell>Type</TableCell>
                <TableCell>Chains</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Details</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {history.map((record) => (
                <TableRow key={record.id}>
                  <TableCell>
                    <Typography variant="body2">{formatDate(record.timestamp)}</Typography>
                  </TableCell>
                  <TableCell>
                    <Chip
                      label={record.type === 'cross-chain' ? 'Cross-Chain' : 'Single-Chain'}
                      size="small"
                      color={record.type === 'cross-chain' ? 'primary' : 'default'}
                    />
                  </TableCell>
                  <TableCell>
                    <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center', flexWrap: 'wrap' }}>
                      {record.chains.map((chainId) => (
                        <Tooltip key={chainId} title={getChainName(chainId)}>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                            {getChainAvatar(chainId)}
                          </Box>
                        </Tooltip>
                      ))}
                    </Box>
                  </TableCell>
                  <TableCell>
                    <Chip
                      label={record.status}
                      size="small"
                      color={
                        record.status === 'success'
                          ? 'success'
                          : record.status === 'failed'
                            ? 'error'
                            : 'warning'
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" color="text.secondary">
                      {record.details || '-'}
                    </Typography>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </CardContent>
    </Card>
  )
}

