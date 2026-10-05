import { isIP } from 'node:net'
import { describe, expect, it } from 'vitest'
import { RTCPeerConnection } from 'werift'
import { getP2PNetworkConfig } from '../../packages/server/src/modules/studio/services/app-relay/p2p-network'

describe('P2P sockets on the running OS', () => {
  it('actually binds each socket to its advertised source and configured UDP range', async () => {
    const { peer: config } = await getP2PNetworkConfig(process.platform, { STUDIO_P2P_UDP_PORT_RANGE: '54000-54127' })
    const pc = new RTCPeerConnection({ ...config, iceServers: [], iceLite: true })
    try {
      pc.createDataChannel('network-test')
      await pc.setLocalDescription(await pc.createOffer())
      const protocols = pc.iceTransports.flatMap(transport => transport.connection.protocols)
      expect(protocols.length).toBeGreaterThan(0)
      for (const protocol of protocols) {
        const [host, port] = protocol.getExtraInfo()
        expect(host).toBe(isIP(host) === 4 ? config.iceInterfaceAddresses?.udp4 : config.iceInterfaceAddresses?.udp6)
        expect(host).toBe(protocol.localCandidate?.host)
        expect(port).toBeGreaterThanOrEqual(54000)
        expect(port).toBeLessThanOrEqual(54127)
      }
    } finally { await pc.close() }
  }, 15_000)
})
