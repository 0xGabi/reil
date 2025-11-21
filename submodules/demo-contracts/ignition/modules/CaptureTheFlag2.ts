import { buildModule } from '@nomicfoundation/hardhat-ignition/modules'

export default buildModule('CaptureTheFlag2Module', (m) => {
  const deployer = m.getAccount(0)
  const captureTheFlag2 = m.contract('CaptureTheFlag2')
  const testUsdc = m.contract('TestUSDC')

  m.call(captureTheFlag2, 'captureFlag', ['Newly Deployed'])
  m.call(testUsdc, 'mint', [deployer, 1000000000])

  return { captureTheFlag2, testUsdc }
})
