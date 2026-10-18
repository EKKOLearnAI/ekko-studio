import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { RTCPeerConnection } from 'werift'
import { addP2PAdvertiseCandidates, getP2PNetworkConfig } from '../../packages/server/src/modules/studio/services/app-relay/p2p-network.ts'

const port = 18670
const udpRange = '62000-62031'
const wait = (promise, timeout = 20_000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('p2p_docker_timeout')), timeout)
  promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
})

if (process.argv.includes('--server')) {
  const network = await getP2PNetworkConfig()
  const pc = new RTCPeerConnection({ ...network.peer, iceServers: [], iceLite: true })
  pc.onDataChannel.subscribe(channel => channel.onMessage.subscribe(data => channel.send(data)))
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/health') { response.end('ready'); return }
      let body = ''
      for await (const chunk of request) body += chunk
      await pc.setRemoteDescription(JSON.parse(body))
      await pc.setLocalDescription(await pc.createAnswer())
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ type: 'answer', sdp: addP2PAdvertiseCandidates(pc.localDescription.sdp, network.advertiseAddresses) }))
    } catch (error) { response.statusCode = 500; response.end(String(error)) }
  })
  server.listen(port, '0.0.0.0')
} else {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const { peer } = await getP2PNetworkConfig(process.platform, {})
  const source = peer.iceInterfaceAddresses?.udp4
  assert.ok(source, 'Docker bridge fixture requires a host IPv4 source')
  const name = `ekko-p2p-network-test-${process.pid}`
  const pc = new RTCPeerConnection({ ...peer, iceUseIpv6: false, iceInterfaceAddresses: { udp4: source }, iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] })
  try {
    execFileSync('docker', ['run', '--rm', '-d', '--name', name,
      '-p', `127.0.0.1:${port}:${port}/tcp`, '-p', `${udpRange}:${udpRange}/udp`,
      '-e', `STUDIO_P2P_UDP_PORT_RANGE=${udpRange}`, '-e', `STUDIO_P2P_ADVERTISE_ADDRESSES=${source}`,
      '-v', `${root}:/workspace:ro`, '-w', '/workspace', 'node:24-bookworm-slim', 'node', 'tests/fixtures/p2p-docker.mjs', '--server'], { stdio: 'pipe' })
    await (async () => {
      for (let attempt = 0; attempt < 80; attempt++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return } catch {}
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      throw new Error('p2p_docker_startup_timeout')
    })()
    const channel = pc.createDataChannel('docker-udp-test')
    const opened = new Promise(resolve => channel.stateChange.subscribe(state => { if (state === 'open') resolve() }))
    const message = 'published Docker UDP data channel: 中文🙂'
    const echoed = new Promise(resolve => channel.onMessage.subscribe(data => resolve(data.toString())))
    await pc.setLocalDescription(await pc.createOffer())
    const response = await fetch(`http://127.0.0.1:${port}/offer`, { method: 'POST', body: JSON.stringify(pc.localDescription) })
    assert.equal(response.status, 200, await response.clone().text())
    await pc.setRemoteDescription(await response.json())
    await wait(opened)
    channel.send(message)
    assert.equal(await wait(echoed), message)
    const pair = pc.iceTransports[0].getSelectedCandidatePair()
    assert.ok(pair.remote.candidate.includes(` ${source} `), 'selected remote is the published host address, not a container-private address')
    console.log(JSON.stringify({ test: 'docker-bridge-published-udp', connection: pc.connectionState, channel: channel.readyState, selectedRemote: pair.remote.candidate, echo: 'passed' }))
  } catch (error) {
    try { console.error(execFileSync('docker', ['logs', name], { encoding: 'utf8' })) } catch {}
    throw error
  } finally {
    await pc.close()
    try { execFileSync('docker', ['rm', '-f', name], { stdio: 'pipe' }) } catch {}
  }
}
