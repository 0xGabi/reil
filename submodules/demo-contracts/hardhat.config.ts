import { configVariable, type HardhatUserConfig } from 'hardhat/config'

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
    chain_1: {
      type: 'http',
      chainType: 'l1',
      accounts: [configVariable("PRIVATE_KEY")],
      url: 'https://virtual.rpc.tenderly.co/stitchApp/project/public/eil-eth'
    },
    chain_10: {
      type: 'http',
      chainType: 'l1',
      accounts: [configVariable("PRIVATE_KEY")],
      url: 'https://virtual.rpc.tenderly.co/stitchApp/project/public/eil-op'
    },
    chain_42161: {
      type: 'http',
      chainType: 'l1',
      accounts: [configVariable("PRIVATE_KEY")],
      url: 'https://virtual.rpc.tenderly.co/stitchApp/project/public/eil-arb'
    },
    chain_8453: {
      type: 'http',
      chainType: 'l1',
      accounts: [configVariable("PRIVATE_KEY")],
      url: 'https://virtual.rpc.tenderly.co/stitchApp/project/public/eil-base'
    }
  },
}

export default config
