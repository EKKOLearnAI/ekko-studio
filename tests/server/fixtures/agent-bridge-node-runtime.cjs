// A local process double for the managed Python command. No Hermes/model loads.
const net = require('node:net')
const fs = require('node:fs')

require.extensions['.py'] = () => {
  const endpoint = process.argv[process.argv.indexOf('--endpoint') + 1]
  const profile = process.env.HERMES_AGENT_BRIDGE_WORKER_PROFILE
  const respondAsWorker = Boolean(profile || process.env.STUDIO_TEST_FORCE_WORKER_PING === '1')
  fs.writeFileSync(process.env.STUDIO_TEST_BRIDGE_ENV_FILE, JSON.stringify({
    endpoint: process.env.HERMES_AGENT_BRIDGE_ENDPOINT,
    profile,
    brokerPid: process.env.HERMES_AGENT_BRIDGE_BROKER_PID,
  }))
  const server = net.createServer(peer => {
    peer.on('error', () => {})
    let buffer = ''
    peer.on('data', data => {
      buffer += data
      if (!buffer.includes('\n')) return
      const request = JSON.parse(buffer.split('\n')[0])
      const response = request.action === 'ping'
        ? { ok: true, pong: true, ...(respondAsWorker ? { profile: profile || 'forced-worker' } : { mode: 'broker' }) }
        : respondAsWorker && request.action === 'status_if_loaded'
          ? { ok: false, error: 'unknown action: status_if_loaded' }
          : { ok: true, exists: false }
      peer.end(JSON.stringify(response) + '\n')
      if (request.action === 'shutdown') server.close(() => process.exit(0))
    })
  })
  if (endpoint.startsWith('ipc://')) server.listen(endpoint.slice(6))
  else {
    const url = new URL(endpoint)
    server.listen(Number(url.port), url.hostname)
  }
}
