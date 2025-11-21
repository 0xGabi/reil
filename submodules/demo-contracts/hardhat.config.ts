import type { HardhatUserConfig } from 'hardhat/config'

import hardhatToolboxViemPlugin from '@nomicfoundation/hardhat-toolbox-viem'
import hardhatVerify from "@nomicfoundation/hardhat-verify";

const config: HardhatUserConfig = {
  plugins: [hardhatToolboxViemPlugin, hardhatVerify],
  verify: {
    etherscan: {
      apiKey: process.env.ETHERSCAN_API_KEY || '',
    },
  },
  solidity: {
    profiles: {
      default: {
        version: '0.8.28',
      },
      production: {
        version: '0.8.28',
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
  networks: {
    chain_10: {
      type: 'http',
      chainType: 'l1',
      url: 'http://localhost:8503'
    },
    chain_8453: {
      type: 'http',
      chainType: 'l1',
      url: 'http://localhost:8502'
    },
    hardhat: {
      type: 'edr-simulated',
      chainId: process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID) : 31337,
    },
    hardhatMainnet: {
      type: 'edr-simulated',
      chainType: 'l1',
    },
    hardhatOp: {
      type: 'edr-simulated',
      chainType: 'op',
    },
  },
}

export default config
