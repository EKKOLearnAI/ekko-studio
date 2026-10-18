import { createServer } from 'http'
import { tmpdir } from 'os'
import { Server } from 'socket.io'
import { io as client, type Socket } from 'socket.io-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ revoked: false, processes: [] as any[] }))
vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({
  authenticateUserToken: async (token: string) => token === 'owner' && !mocks.revoked
    ? { id: 1, role: 'super_admin' } : token === 'viewer' ? { id: 2, role: 'admin' } : null,
}))
vi.mock('../../packages/server/src/modules/hermes/services/profiles/profile', async () => {
  const { tmpdir } = await import('os')
  return { getProfileDir: () => tmpdir(), listProfileNamesFromDisk: () => ['default', 'other'] }
})
vi.mock('../../packages/server/src/modules/hermes/services/terminal/runtime', () => ({
  canOpenTerminal: (user: any) => user?.role === 'super_admin', findShell: () => '/bin/sh', resolveTerminalCwd: () => '/tmp',
  pty: { spawn: vi.fn((_shell: string, _args: string[], options: any) => {
    let output = (_: string) => {}
    const process = { pid: 123456789, options, onData: (fn: typeof output) => { output = fn }, onExit: vi.fn(),
      write: vi.fn((data: string) => output(data)), resize: vi.fn(), kill: vi.fn() }
    mocks.processes.push(process); return process
  }) },
}))
vi.mock('../../packages/server/src/modules/studio/public/process-tree', () => ({ killOwnedProcessTree: (_: number, kill: () => void) => kill() }))
import { setupMobileTerminal } from '../../packages/server/src/modules/hermes/sockets/mobile-terminal'

let io: Server
let service: ReturnType<typeof setupMobileTerminal>
let origin = ''
const clients: Socket[] = []
beforeEach(async () => {
  mocks.revoked = false; mocks.processes.length = 0
  const http = createServer(); io = new Server(http)
  service = setupMobileTerminal(io, c => c.sourceId === 'chat' ? { profile: 'default', workspace: tmpdir() } : null)
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(http.address() as any).port}`
})
afterEach(async () => {
  clients.splice(0).forEach(s => s.disconnect()); service.close()
  await new Promise<void>(resolve => io.close(() => resolve()))
})
async function connect(token = 'owner', sourceId = 'chat', profile = 'default') {
  const socket = client(`${origin}/terminal`, { auth: { token }, query: { source: 'single', sourceId, profile }, transports: ['websocket'], reconnection: false })
  clients.push(socket)
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject) })
  return socket
}
async function request(socket: Socket, event: string, payload = {}): Promise<any> {
  return socket.timeout(1000).emitWithAck(`terminal.${event}`, payload)
}

describe('mobile terminal Socket.IO authorization and recovery', () => {
  it('pushes output and backspace over the socket using the existing read subscription operation', async () => {
    const a = await connect(); const other = await connect()
    const leaked = vi.fn(); other.on('terminal.output', leaked)
    expect(await request(a, 'capabilities')).toMatchObject({ data: { outputPush: true } })
    const created = await request(a, 'create', { requestId: 'request-push', cols: 80, rows: 24 })
    const terminalId = created.data.terminal.id
    const attached = await request(a, 'attach', { terminalId }); const lease = attached.data.lease
    expect(await request(a, 'read', { terminalId, lease, cursor: 0, stream: true })).toMatchObject({ data: { streaming: true } })
    const output = vi.fn(); a.on('terminal.output', output)
    await request(a, 'input', { terminalId, lease, seq: 1, data: 'a' })
    await vi.waitFor(() => expect(output).toHaveBeenCalledTimes(1))
    await request(a, 'input', { terminalId, lease, seq: 2, data: '\b \b' })
    await vi.waitFor(() => expect(output).toHaveBeenCalledTimes(2))
    expect(output.mock.calls.map(([frame]) => frame.chunks[0].data)).toEqual(['a', '\b \b'])
    expect(output.mock.calls[1][0]).toMatchObject({ terminalId, lease, cursor: 2 })
    expect(leaked).not.toHaveBeenCalled()
    mocks.revoked = true
    expect(await request(a, 'read', { terminalId, lease, cursor: 2, stream: true })).toMatchObject({ error: 'terminal_forbidden' })
    expect(mocks.processes[0].kill).toHaveBeenCalledTimes(1)
  })
  it('rejects non-admin, invalid credentials and unrelated chat/profile scopes', async () => {
    await expect(connect('viewer')).rejects.toThrow('terminal_forbidden')
    await expect(connect('bad')).rejects.toThrow('terminal_forbidden')
    await expect(connect('owner', 'missing')).rejects.toThrow('terminal_invalid_context')
    await expect(connect('owner', 'chat', 'other')).rejects.toThrow('terminal_invalid_context')
  })
  it('creates in the server-resolved directory and resumes the same process through a new bridge', async () => {
    const a = await connect()
    expect(await request(a, 'capabilities')).toMatchObject({ ok: true, data: { version: 1, available: true } })
    const created = await request(a, 'create', { requestId: 'request-0001', cols: 80, rows: 24, cwd: '/untrusted' })
    const id = created.data.terminal.id
    expect(mocks.processes[0].options.cwd).toBe(tmpdir())
    const attached = await request(a, 'attach', { terminalId: id })
    const lease = attached.data.lease
    expect(await request(a, 'input', { terminalId: id, lease, seq: 1, data: 'echo one\r' })).toMatchObject({ ok: true })
    a.disconnect()
    const b = await connect()
    expect(await request(b, 'list')).toMatchObject({ data: { terminals: [{ id }] } })
    const next = await request(b, 'attach', { terminalId: id })
    expect(await request(b, 'read', { terminalId: id, lease: next.data.lease, cursor: 0 }))
      .toMatchObject({ data: { chunks: [{ seq: 1, data: 'echo one\r' }] } })
    expect(mocks.processes).toHaveLength(1)
    expect(mocks.processes[0].write).toHaveBeenCalledTimes(1)
    await request(b, 'close', { terminalId: id })
    expect(mocks.processes[0].kill).toHaveBeenCalledTimes(1)
  })
  it('checks revocation on each operation and ends revoked sessions', async () => {
    const a = await connect()
    await request(a, 'create', { requestId: 'request-0001', cols: 80, rows: 24 })
    mocks.revoked = true
    expect(await request(a, 'list')).toMatchObject({ ok: false, error: 'terminal_forbidden' })
    expect(mocks.processes[0].kill).toHaveBeenCalledTimes(1)
  })
})
