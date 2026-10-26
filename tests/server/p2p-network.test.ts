import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { addP2PAdvertiseCandidates, getP2PNetworkConfig, parseLinuxP2PRoutes, parseWindowsP2PRoutes, selectP2PNetwork } from '../../packages/server/src/modules/studio/services/app-relay/p2p-network'

vi.mock('node:os', () => ({ networkInterfaces: vi.fn() }))
vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: vi.fn() }))
const address = (value: string, internal = false): NetworkInterfaceInfo => ({
  address: value, family: value.includes(':') ? 'IPv6' : 'IPv4', internal,
  netmask: '', mac: '', cidr: null, ...(value.includes(':') ? { scopeid: 0 } : {}),
}) as NetworkInterfaceInfo
const ipv4Routes = 'Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\neth0 00000000 010011AC 0003 0 0 100 00000000 0 0 0\nwlan0 00000000 0101A8C0 0003 0 0 600 00000000 0 0 0\neth0 000011AC 00000000 0001 0 0 0 0000FFFF 0 0 0\n'
const ipv6Routes = `${'0'.repeat(32)} 00 ${'0'.repeat(32)} 00 fe800000000000000000000000000001 00000064 00000000 00000000 00000003 eth0\n${'0'.repeat(32)} 00 ${'0'.repeat(32)} 00 ${'0'.repeat(32)} ffffffff 00000000 00000000 00200200 lo\n`

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(networkInterfaces).mockReturnValue({ en0: [address('192.168.1.2'), address('2001:db8::2')] })
  vi.mocked(readFile).mockImplementation((path => Promise.resolve(String(path).endsWith('ipv6_route') ? ipv6Routes : ipv4Routes)) as any)
  vi.mocked(execFile).mockImplementation(((file: string, args: string[], _options: unknown, callback: Function) => callback(null,
    file === 'powershell.exe' ? '[{"InterfaceAlias":"以太网","Family":"IPv4","Metric":25}]' : `    interface: ${args.includes('-inet6') ? 'en1' : 'en0'}\n`, '')) as any)
})

describe('P2P network selection across platforms', () => {
  it('binds macOS IPv4 and IPv6 to their respective uplinks, not wildcard or TUN addresses', async () => {
    vi.mocked(networkInterfaces).mockReturnValue({ utun4: [address('198.18.0.1')], en0: [address('192.168.1.2')], en1: [address('2001:db8::3')] })
    expect((await getP2PNetworkConfig('darwin', {})).peer).toEqual({
      iceInterfaceAddresses: { udp4: '192.168.1.2', udp6: '2001:db8::3' }, iceUseIpv4: true, iceUseIpv6: true,
    })
    expect(execFile).toHaveBeenCalledWith('/sbin/route', ['-n', 'get', 'default'], expect.objectContaining({ timeout: 3000 }), expect.any(Function))
  })

  it('selects Windows localized interface aliases using route metrics', async () => {
    vi.mocked(networkInterfaces).mockReturnValue({ 'VPN': [address('10.0.0.1')], 'Wi-Fi': [address('192.168.1.4')], '以太网': [address('192.168.1.3')] })
    expect((await getP2PNetworkConfig('win32', {})).peer.iceInterfaceAddresses).toEqual({ udp4: '192.168.1.3' })
    expect(execFile).toHaveBeenCalledWith('powershell.exe', expect.arrayContaining(['-NoProfile', '-NonInteractive']), expect.objectContaining({ windowsHide: true }), expect.any(Function))
  })

  it('parses both single-object and array Windows JSON, including a UTF-8 BOM', () => {
    expect(parseWindowsP2PRoutes('\uFEFF{"InterfaceAlias":"以太网","Family":"IPv4","Metric":25}')).toEqual([{ interface: '以太网', family: 4, metric: 25 }])
    expect(parseWindowsP2PRoutes('[{"InterfaceAlias":"Wi-Fi","Family":"IPv6","Metric":10},{"Family":"invalid"}]')).toEqual([{ interface: 'Wi-Fi', family: 6, metric: 10 }])
  })

  it('uses Linux kernel routes without requiring iproute2 or a shell in Docker', async () => {
    vi.mocked(networkInterfaces).mockReturnValue({ wlan0: [address('192.168.1.2')], eth0: [address('172.17.0.2'), address('2001:db8::2')], docker0: [address('172.18.0.1')] })
    expect((await getP2PNetworkConfig('linux', {})).peer.iceInterfaceAddresses).toEqual({ udp4: '172.17.0.2', udp6: '2001:db8::2' })
    expect(execFile).not.toHaveBeenCalled()
    expect(parseLinuxP2PRoutes(ipv4Routes, ipv6Routes)).toEqual([
      { interface: 'eth0', family: 4, metric: 100 }, { interface: 'wlan0', family: 4, metric: 600 }, { interface: 'eth0', family: 6, metric: 100 },
    ])
  })

  it('keeps container eth0 eligible while skipping host bridges, VPNs and fake-IP addresses', () => {
    expect(selectP2PNetwork({ tun0: [address('10.0.0.1')], docker0: [address('172.18.0.1')], veth123: [address('172.18.0.2')], 'vEthernet (Default Switch)': [address('172.19.0.1')], eth0: [address('172.17.0.2')] }).iceInterfaceAddresses).toEqual({ udp4: '172.17.0.2' })
    expect(selectP2PNetwork({ en0: [address('169.254.1.2'), address('fe80::1')], en1: [address('198.18.0.2')], en2: [address('127.0.0.1', true)], en3: [address('192.168.1.3')] }).iceInterfaceAddresses).toEqual({ udp4: '192.168.1.3' })
    expect(() => selectP2PNetwork({ utun4: [address('198.18.0.1')], lo0: [address('127.0.0.1', true)] })).toThrow('p2p_network_unavailable')
  })

  it('supports IPv6-only, IPv4-only, and LAN ULA addresses without wildcard sockets', () => {
    expect(selectP2PNetwork({ eth0: [address('fe80::1'), address('fd00::1'), address('2001:db8::2')] })).toEqual({ iceInterfaceAddresses: { udp6: '2001:db8::2' }, iceUseIpv4: false, iceUseIpv6: true })
    expect(selectP2PNetwork({ eth0: [address('fd00::1')] }).iceInterfaceAddresses).toEqual({ udp6: 'fd00::1' })
  })

  it('allows an explicit network even with a nonstandard or VPN name and avoids shell interpolation', async () => {
    vi.mocked(networkInterfaces).mockReturnValue({ 'Work VPN; $(echo x)': [address('10.0.0.2')], eth0: [address('192.168.1.2')] })
    expect((await getP2PNetworkConfig('win32', { STUDIO_P2P_INTERFACE: 'Work VPN; $(echo x)' })).peer.iceInterfaceAddresses).toEqual({ udp4: '10.0.0.2' })
    expect(execFile).not.toHaveBeenCalled()
    await expect(getP2PNetworkConfig('darwin', { STUDIO_P2P_INTERFACE: 'missing' })).rejects.toThrow('p2p_network_unavailable')
  })

  it('re-reads the uplink after network changes and tolerates unavailable route commands', async () => {
    vi.mocked(execFile).mockImplementation(((_file: string, _args: string[], _options: unknown, callback: Function) => callback(new Error('route unavailable'))) as any)
    vi.mocked(networkInterfaces).mockReturnValueOnce({ en1: [address('192.168.1.3')] }).mockReturnValueOnce({ en0: [address('192.168.2.2')] })
    expect((await getP2PNetworkConfig('darwin', {})).peer.iceInterfaceAddresses).toEqual({ udp4: '192.168.1.3' })
    expect((await getP2PNetworkConfig('darwin', {})).peer.iceInterfaceAddresses).toEqual({ udp4: '192.168.2.2' })
  })

  it('uses interface enumeration if proc route files are unavailable', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('not mounted'))
    expect((await getP2PNetworkConfig('linux', {})).peer.iceInterfaceAddresses?.udp4).toBe('192.168.1.2')
  })

  it('configures a bounded UDP range and published Docker addresses', async () => {
    expect(await getP2PNetworkConfig('darwin', { STUDIO_P2P_UDP_PORT_RANGE: '50000-50127', STUDIO_P2P_ADVERTISE_ADDRESSES: '192.168.1.20,192.168.1.20,2001:db8::20' })).toMatchObject({ peer: { icePortRange: [50000, 50127] }, advertiseAddresses: ['192.168.1.20', '2001:db8::20'] })
    expect((await getP2PNetworkConfig('darwin', {})).peer.icePortRange).toBeUndefined()
  })

  it.each(['0-100', '65530-65540', '50100-50000', '50000', '1e4-10001', '5000-15000'])('rejects invalid UDP ranges: %s', async range => {
    await expect(getP2PNetworkConfig('darwin', { STUDIO_P2P_UDP_PORT_RANGE: range })).rejects.toThrow('p2p_invalid_port_range')
  })

  it.each(['turn:example.com', '127.0.0.1', '198.18.0.1', '224.0.0.1', 'fe80::1'])('rejects unusable published addresses: %s', async address => {
    await expect(getP2PNetworkConfig('darwin', { STUDIO_P2P_UDP_PORT_RANGE: '50000-50127', STUDIO_P2P_ADVERTISE_ADDRESSES: address })).rejects.toThrow('p2p_invalid_advertise_addresses')
  })

  it('requires stable ports and a matching bound address family for published candidates', async () => {
    await expect(getP2PNetworkConfig('darwin', { STUDIO_P2P_ADVERTISE_ADDRESSES: '192.168.1.20' })).rejects.toThrow('p2p_invalid_advertise_addresses')
    vi.mocked(networkInterfaces).mockReturnValue({ en0: [address('192.168.1.2')] })
    await expect(getP2PNetworkConfig('darwin', { STUDIO_P2P_UDP_PORT_RANGE: '50000-50127', STUDIO_P2P_ADVERTISE_ADDRESSES: '2001:db8::20' })).rejects.toThrow('p2p_invalid_advertise_addresses')
  })
})

describe('published Docker ICE candidates', () => {
  it('adds same-port host candidates per address family before end-of-candidates without altering credentials or srflx candidates', () => {
    const sdp = ['v=0', 'a=ice-ufrag:local', 'a=candidate:one 1 udp 2116026367 172.17.0.2 50000 typ host generation 0 ufrag local', 'a=candidate:two 1 udp 2116026367 2001:db8::2 50001 typ host', 'a=candidate:three 1 udp 1679818751 203.0.113.1 60000 typ srflx raddr 172.17.0.2 rport 50000', 'a=end-of-candidates', ''].join('\r\n')
    const result = addP2PAdvertiseCandidates(sdp, ['192.168.1.20', '2001:db8::20'])
    expect(result).toContain(' 192.168.1.20 50000 typ host generation 0 ufrag local\r\n')
    expect(result).toContain(' 2001:db8::20 50001 typ host\r\n')
    expect(result).not.toContain(' 192.168.1.20 50001 ')
    expect(result.indexOf('192.168.1.20')).toBeLessThan(result.indexOf('a=end-of-candidates'))
    for (const line of sdp.split('\r\n')) expect(result.split('\r\n')).toContain(line)
    expect(addP2PAdvertiseCandidates(sdp, [])).toBe(sdp)
    expect(addP2PAdvertiseCandidates(sdp, ['172.17.0.2'])).toBe(sdp)
  })
})
