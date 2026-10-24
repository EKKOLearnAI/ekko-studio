import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { windowsCmdShimExecution } from '../../packages/server/src/modules/studio/public/windows-command'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), prepare: vi.fn(), kill: vi.fn(), home: '' }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('../../packages/server/src/modules/studio/public/process-tree', () => ({ killOwnedProcessTree: mocks.kill }))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ getWebUiHome: () => mocks.home }))
vi.mock('../../packages/server/src/modules/coding-agents/services/dsh/management-profile', () => ({ prepareDshManagementProfile: mocks.prepare }))
import { DshManagement } from '../../packages/server/src/modules/coding-agents/services/dsh/management'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
let child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; exitCode: number | null; signalCode: null; pid: number }
let management: DshManagement

beforeEach(async () => {
  mocks.home = await mkdtemp(join(tmpdir(), 'dsh-management-test-'))
  child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, pid: 424242 })
  mocks.spawn.mockReset().mockReturnValue(child)
  mocks.kill.mockReset().mockImplementation(async () => { child.exitCode = 0; child.emit('close', 0) })
  mocks.prepare.mockReset().mockResolvedValue({ profile: 'studio-plugins', patch: join(mocks.home, 'management.patch.yml') })
  management = new DshManagement({
    runtimeInput: async () => ({ installationCommand: 'C:\\Users\\测试 User\\npm\\dsh.cmd', sourceHome: join(mocks.home, 'source') }),
    commandEnv: async () => ({ PATH: 'fixture-toolchain' }), commandExecution: windowsCmdShimExecution,
  })
})
afterEach(async () => {
  vi.useRealTimers()
  await management.close()
  child.stdout.destroy(); child.stderr.destroy()
  Object.defineProperty(process, 'platform', originalPlatform)
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await rm(mocks.home, { recursive: true, force: true })
})

async function start() {
  // Observe the rejection immediately, including failures emitted before awaiting.
  const result = management.open().catch(error => error)
  await vi.waitFor(() => expect(child.listenerCount('error')).toBe(1))
  return { result }
}

it('launches a Windows shim through the platform helper with verbatim argv and isolated state', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const { result } = await start()
  const [command, args, options] = mocks.spawn.mock.calls[0]
  expect(command).toBe(process.env.comspec || 'cmd.exe')
  expect(args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
  expect(args[3]).toContain('测试^ User\\npm\\dsh.cmd')
  expect(args[3]).toContain('^"--profile^" ^"studio-plugins^"')
  expect(options).toMatchObject({ detached: false, windowsHide: true, windowsVerbatimArguments: true,
    cwd: join(mocks.home, 'source'), env: { PATH: 'fixture-toolchain', ELECTRON_RUN_AS_NODE: '1' } })
  expect(options.env.DSH_HOME).toContain(join(mocks.home, 'coding-agents/dsh/management/host-'))
  child.emit('error', Object.assign(new Error('private command path'), { code: 'ENOENT' }))
  expect(await result).toMatchObject({ status: 503, code: 'DSH_UI_UNAVAILABLE',
    message: 'Unable to start the DSH configuration runtime (process launch failed: ENOENT)' })
})

it('reports early exit without exposing native plugin output', async () => {
  const { result } = await start()
  child.stderr.write('plugin secret=private-api-key')
  child.exitCode = 127
  child.emit('close', 127)
  expect(await result).toMatchObject({ message: 'Unable to start the DSH configuration runtime (process exited before readiness: 127)' })
})

it('reports a bounded readiness timeout', async () => {
  vi.useFakeTimers()
  const { result } = await start()
  await vi.advanceTimersByTimeAsync(180_000)
  expect(await result).toMatchObject({ message: 'Unable to start the DSH configuration runtime (readiness timed out after 180 seconds)' })
})

it.each(['connection', 'frontend probe'])('reports native %s failure without token or cookie values', async stage => {
  const fetch = vi.fn().mockRejectedValue(new Error('private-token private-cookie'))
  if (stage === 'frontend probe') fetch.mockResolvedValueOnce(new Response(null, { status: 303, headers: { 'set-cookie': 'auth=private-cookie' } }))
  vi.stubGlobal('fetch', fetch)
  const { result } = await start()
  child.stdout.write('STUDIO_DSH_UI_READY:http://127.0.0.1:12345/?token=private-token\n')
  expect(await result).toMatchObject({ message: `Unable to start the DSH configuration runtime (native ${stage} failed)` })
})

it('identifies a native runtime that stopped listening instead of reporting an authentication rejection', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('private-token', {
    cause: Object.assign(new Error('private command path'), { code: 'ECONNREFUSED' }),
  })))
  const { result } = await start()
  child.stdout.write('STUDIO_DSH_UI_READY:http://127.0.0.1:12345/?token=private-token\n')
  expect(await result).toMatchObject({ status: 503, code: 'DSH_UI_UNAVAILABLE',
    message: 'Unable to start the DSH configuration runtime (native connection failed: ECONNREFUSED)' })
})

it.each([401, 403, 303])('reports rejected authentication or a missing cookie with HTTP %s', async status => {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status }))
  vi.stubGlobal('fetch', fetch)
  const { result } = await start()
  child.stdout.write('STUDIO_DSH_UI_READY:http://127.0.0.1:12345/?token=private-token\n')
  expect(await result).toMatchObject({
    message: `Unable to start the DSH configuration runtime (native authentication failed (HTTP ${status}))`,
  })
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('returns the authenticated target and reuses the running host', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(new Response(null, { status: 303, headers: { 'set-cookie': 'auth=fixture; HttpOnly' } }))
    .mockResolvedValueOnce(new Response('native frontend')))
  const { result } = await start()
  child.stdout.write('STUDIO_DSH_UI_READY:http://127.0.0.1:12345/?token=fixture\n')
  const target = await result
  expect(target).toMatchObject({ endpoint: 'http://127.0.0.1:12345', cookie: 'auth=fixture' })
  expect(await management.open()).toEqual(target)
  expect(mocks.spawn).toHaveBeenCalledTimes(1)
})

it.each([
  { delay: 43_000, budget: undefined },
  { delay: 190_000, budget: '360000' },
])('allows a slow native startup at $delay ms with budget $budget', async ({ delay, budget }) => {
  vi.stubEnv('HERMES_DSH_READY_TIMEOUT_MS', budget)
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(new Response(null, { status: 303, headers: { 'set-cookie': 'auth=fixture' } }))
    .mockResolvedValueOnce(new Response('native frontend')))
  const { result } = await start()
  await vi.advanceTimersByTimeAsync(delay)
  expect(mocks.kill).not.toHaveBeenCalled()
  child.stdout.write('STUDIO_DSH_UI_READY:http://127.0.0.1:12345/?token=fixture\n')
  expect(await result).toMatchObject({ endpoint: 'http://127.0.0.1:12345', cookie: 'auth=fixture' })
  expect(await management.open()).toMatchObject({ endpoint: 'http://127.0.0.1:12345' })
  expect(mocks.spawn).toHaveBeenCalledTimes(1)
})

it('honors a shorter configured budget and terminates the owned process', async () => {
  vi.stubEnv('HERMES_DSH_READY_TIMEOUT_MS', '12000')
  vi.useFakeTimers()
  const { result } = await start()
  await vi.advanceTimersByTimeAsync(12_000)
  const stoppedAtDeadline = mocks.kill.mock.calls.length === 1
  // Settle the original fixed deadline too, so a regression fails without hanging.
  await vi.advanceTimersByTimeAsync(30_000)
  expect(stoppedAtDeadline).toBe(true)
  expect(await result).toMatchObject({ code: 'DSH_UI_UNAVAILABLE', message: 'Unable to start the DSH configuration runtime (readiness timed out after 12 seconds)' })
  expect(mocks.kill).toHaveBeenCalledWith(424242, expect.any(Function))
})

it.each(['', '0', '-1', 'not-a-number', 'Infinity', '1.5', '2147483648'])(
  'falls back to the bounded default for invalid budget %j', async budget => {
    vi.stubEnv('HERMES_DSH_READY_TIMEOUT_MS', budget)
    vi.useFakeTimers()
    const { result } = await start()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(await result).toMatchObject({ message: 'Unable to start the DSH configuration runtime (readiness timed out after 180 seconds)' })
    expect(mocks.kill).toHaveBeenCalledTimes(1)
  }
)
