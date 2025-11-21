import { describe, it } from 'node:test'

import { network } from 'hardhat'

describe('CaptureTheFlag2', async function () {
  const { viem } = await network.connect()

  await it('Should emit the FlagCaptured event when calling the captureFlag() function', async function () {
    const ctf =
      await viem.deployContract('CaptureTheFlag2')
    const nakamoto = 'Satoshi Nakamoto'
    const buterin = 'Vitalik Buterin'
    await viem.assertions.emitWithArgs(
      ctf.write.captureFlag([nakamoto]),
      ctf,
      'FlagCaptured',
      ['', nakamoto],
    )
    await viem.assertions.emitWithArgs(
      ctf.write.captureFlag([buterin]),
      ctf,
      'FlagCaptured',
      [nakamoto, buterin],
    )
  })
})
