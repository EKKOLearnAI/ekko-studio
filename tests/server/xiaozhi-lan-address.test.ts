import { describe, expect, it } from 'vitest'
import type { NetworkInterfaceInfo } from 'node:os'
import { selectXiaozhiLanAddress } from '../../packages/server/src/modules/studio/services/xiaozhi-provisioning'

const address = (value: string): NetworkInterfaceInfo => ({
  address: value, family: 'IPv4', internal: false, mac: '00:00:00:00:00:00',
  netmask: '255.255.255.0', cidr: `${value}/24`,
})

describe('XiaoZhi LAN address selection', () => {
  const interfaces = {
    docker0: [address('172.17.0.1')],
    wlan0: [address('6.6.6.89')],
    eth0: [address('192.168.2.147')],
  }

  it('uses the address actually reached by the device', () => {
    expect(selectXiaozhiLanAddress(interfaces, '6.6.6.89', 'malicious.example')).toBe('6.6.6.89')
    expect(selectXiaozhiLanAddress(interfaces, '::ffff:192.168.2.147')).toBe('192.168.2.147')
  })

  it('uses the browser-facing host when Vite proxies the Devices page', () => {
    expect(selectXiaozhiLanAddress(interfaces, '127.0.0.1', '6.6.6.89:6060')).toBe('6.6.6.89')
  })

  it('ignores untrusted hosts and prefers the active Wi-Fi interface', () => {
    expect(selectXiaozhiLanAddress(interfaces, '127.0.0.1', '8.8.8.8:6060')).toBe('6.6.6.89')
    expect(selectXiaozhiLanAddress(interfaces, '127.0.0.1', 'malicious.example')).toBe('6.6.6.89')
  })

  it('does not return a virtual interface when no physical LAN is available', () => {
    expect(selectXiaozhiLanAddress({ docker0: [address('172.17.0.1')] })).toBeUndefined()
  })
})
