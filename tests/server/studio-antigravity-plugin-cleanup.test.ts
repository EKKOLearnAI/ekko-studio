import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNativeRuntime } from '../../plugins/antigravity/src/runtime'
import { geminiBridge } from '../../plugins/antigravity/src/gemini'
import {
  type AgentRunContext,
  type AgentRuntimeContext,
  type ModelGatewayHandle,
  type ProcessHandle,
} from '../../packages/studio-plugin-sdk/src'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rm: vi.fn(actual.rm) }
})
vi.mock('../../plugins/antigravity/src/gemini', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../plugins/antigravity/src/gemini')>()),
  geminiBridge: vi.fn(),
}))
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const roots: string[] = []
const isImageTurnDirectory = (value: unknown) => String(value).replaceAll('\\', '/').includes('/images/turn-')
beforeEach(() => {
  vi.mocked(rm).mockReset().mockImplementation(actualFs.rm)
  vi.mocked(geminiBridge).mockReset()
})
afterEach(async () => {
  for (const path of roots.splice(0)) await actualFs.rm(path, { recursive: true, force: true })
})
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'studio-antigravity-cleanup-'))
  roots.push(root)
  const processDisposed = vi.fn(async () => {}),
    bridgeDisposed = vi.fn(async () => {}),
    gatewayDisposed = vi.fn(async () => {})
  const bridge = { baseUrl: 'http://127.0.0.1:1', token: 'native-only', dispose: bridgeDisposed }
  vi.mocked(geminiBridge).mockResolvedValue(bridge)
  const gateway: ModelGatewayHandle = {
    baseUrl: 'http://127.0.0.1:2/v1',
    token: 'host-only',
    model: 'fixture/model',
    protocol: 'responses',
    images: true,
    dispose: gatewayDisposed,
  }
  const spawn = vi.fn(async () => {
    let read = 0
    const handle: ProcessHandle = {
      id: 'native-process',
      write: vi.fn(async () => {}),
      end: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      dispose: processDisposed,
      read: vi.fn(async () => {
        if (read++ === 0)
          return {
            chunks: [
              {
                stream: 'stdout' as const,
                data: Buffer.from(
                  [
                    { event: 'init', conversation_id: 'native-session' },
                    { event: 'result', result: { conversation_id: 'native-session', status: 'SUCCESS', response: 'Native success' } },
                  ]
                    .map((value) => JSON.stringify(value))
                    .join('\n') + '\n',
                ),
              },
            ],
            truncated: false,
            exit: null,
          }
        return { chunks: [], truncated: false, exit: { code: 0, signal: null } }
      }),
    }
    return handle
  })
  const nativeContext = {
    stateDirectory: join(root, 'state'),
    runtimeSessionId: 'lease',
    processes: { spawn },
    signal: new AbortController().signal,
  } as unknown as AgentRuntimeContext
  const runtime = createNativeRuntime(
    {
      instanceId: 'instance',
      configRevision: 1,
      mode: 'scoped',
      config: { cwd: root, command: 'fixture-agy', env: { HOME: root }, model: 'fixture/model' },
    },
    nativeContext,
  )
  const context = (runId: string) =>
    ({
      signal: new AbortController().signal,
      scope: { runId },
      models: { gateway: vi.fn(async () => gateway) },
      artifacts: {
        read: async (id: string, offset: number) => ({
          id,
          offset,
          byteLength: 3,
          mediaType: 'image/png',
          data: 'YWJj',
          nextOffset: 3,
          done: true,
        }),
      },
    }) as unknown as AgentRunContext
  const input = {
    content: [
      { type: 'text' as const, text: 'hello' },
      { type: 'image' as const, artifactId: 'image', mediaType: 'image/png' },
    ],
  }
  const events = async (handle: Awaited<ReturnType<typeof runtime.run>>) => {
    const output = []
    for await (const event of handle.events) output.push(event)
    return output
  }
  return { root, runtime, input, context, events, spawn, processDisposed, bridgeDisposed, gatewayDisposed }
}

it.each(['process', 'bridge', 'gateway', 'images'] as const)(
  'retires the same runtime after unconfirmed %s cleanup and still cleans its other resources',
  async (resource) => {
    const f = await fixture(),
      failure = new Error(`${resource} cleanup was not confirmed`)
    if (resource === 'process') f.processDisposed.mockRejectedValueOnce(failure)
    if (resource === 'bridge') f.bridgeDisposed.mockRejectedValueOnce(failure)
    if (resource === 'gateway') f.gatewayDisposed.mockRejectedValueOnce(failure)
    if (resource === 'images')
      vi.mocked(rm).mockImplementation(async (path, options) => {
        if (isImageTurnDirectory(path)) throw failure
        return actualFs.rm(path, options)
      })
    const handle = await f.runtime.run(f.input, f.context('failed-cleanup')),
      drained = f.events(handle)
    await expect(handle.result).rejects.toBe(failure)
    expect((await drained).some((event) => event.type === 'checkpoint.updated')).toBe(false)
    expect(f.processDisposed).toHaveBeenCalledOnce()
    expect(f.bridgeDisposed).toHaveBeenCalledOnce()
    expect(f.gatewayDisposed).toHaveBeenCalledOnce()
    expect(vi.mocked(rm).mock.calls.some(([path]) => isImageTurnDirectory(path))).toBe(true)
    await expect(f.runtime.run(f.input, f.context('must-not-start'))).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    expect(f.spawn).toHaveBeenCalledOnce()
    // A later successful call to a transient disposer cannot unretire the lease.
    if (resource === 'bridge') await f.bridgeDisposed()
    if (resource === 'gateway') await f.gatewayDisposed()
    await expect(f.runtime.run(f.input, f.context('still-retired'))).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  },
)

it('does not resolve success or publish a checkpoint until image cleanup confirms after gateway accounting', async () => {
  const f = await fixture(),
    gatewayGate = deferred<void>(),
    imagesGate = deferred<void>()
  f.gatewayDisposed.mockImplementation(() => gatewayGate.promise)
  vi.mocked(rm).mockImplementation(async (path, options) => {
    if (isImageTurnDirectory(path)) await imagesGate.promise
    return actualFs.rm(path, options)
  })
  const handle = await f.runtime.run(f.input, f.context('barrier')),
    drained = f.events(handle)
  let outcome: Awaited<typeof handle.result> | undefined
  void handle.result.then((result) => {
    outcome = result
  })
  await vi.waitFor(() => expect(f.gatewayDisposed).toHaveBeenCalledOnce())
  expect(outcome).toBeUndefined()
  await expect(f.runtime.run(f.input, f.context('busy'))).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  gatewayGate.resolve()
  await vi.waitFor(() => expect(vi.mocked(rm).mock.calls.some(([path]) => isImageTurnDirectory(path))).toBe(true))
  expect(outcome).toBeUndefined()
  imagesGate.resolve()
  await expect(handle.result).resolves.toMatchObject({
    status: 'completed',
    checkpoint: { nativeSessionId: 'native-session', shadowId: expect.any(String) },
  })
  await drained
  const next = await f.runtime.run(f.input, f.context('next')),
    nextEvents = f.events(next)
  await expect(next.result).resolves.toMatchObject({ status: 'completed', checkpoint: outcome!.checkpoint })
  await nextEvents
  expect(f.spawn).toHaveBeenCalledTimes(2)
})

it('propagates process cleanup failure from cancellation and keeps the runtime retired', async () => {
  const f = await fixture(),
    failure = new Error('cancel cleanup failed'),
    readGate = deferred<Awaited<ReturnType<ProcessHandle['read']>>>()
  f.spawn.mockImplementationOnce(async () => ({
    id: 'waiting',
    read: async () => readGate.promise,
    write: async () => {},
    end: async () => {},
    stop: async () => {},
    dispose: async () => {
      readGate.reject(failure)
      throw failure
    },
  }))
  const handle = await f.runtime.run(f.input, f.context('cancel')),
    drained = f.events(handle)
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce())
  await expect(handle.cancel('cancelled')).rejects.toBe(failure)
  await expect(handle.result).rejects.toBe(failure)
  await drained
  expect(f.bridgeDisposed).toHaveBeenCalledOnce()
  expect(f.gatewayDisposed).toHaveBeenCalledOnce()
  await expect(f.runtime.run(f.input, f.context('must-not-start'))).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
})

it('retains the first cleanup failure while attempting later failing resources', async () => {
  const f = await fixture(),
    first = new Error('process unconfirmed'),
    later = new Error('gateway unconfirmed')
  f.processDisposed.mockRejectedValueOnce(first)
  f.gatewayDisposed.mockRejectedValueOnce(later)
  const handle = await f.runtime.run(f.input, f.context('multiple-failures')),
    drained = f.events(handle)
  await expect(handle.result).rejects.toBe(first)
  await drained
  expect(f.gatewayDisposed).toHaveBeenCalledOnce()
  expect(vi.mocked(rm).mock.calls.some(([path]) => isImageTurnDirectory(path))).toBe(true)
  await expect(f.runtime.run(f.input, f.context('retired'))).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
})

it.each(['bridge', 'gateway', 'images'] as const)('reports %s cleanup failure from cancel after the process stopped', async (resource) => {
  const f = await fixture(),
    failure = new Error(`${resource} cancellation cleanup failed`),
    readGate = deferred<Awaited<ReturnType<ProcessHandle['read']>>>()
  f.spawn.mockImplementationOnce(async () => ({
    id: 'waiting',
    read: async () => readGate.promise,
    write: async () => {},
    end: async () => {},
    stop: async () => {},
    dispose: async () => {
      readGate.resolve({ chunks: [], truncated: false, exit: { code: 0, signal: null } })
    },
  }))
  if (resource === 'bridge') f.bridgeDisposed.mockRejectedValueOnce(failure)
  if (resource === 'gateway') f.gatewayDisposed.mockRejectedValueOnce(failure)
  if (resource === 'images')
    vi.mocked(rm).mockImplementation(async (path, options) => {
      if (isImageTurnDirectory(path)) throw failure
      return actualFs.rm(path, options)
    })
  const handle = await f.runtime.run(f.input, f.context('cancel-cleanup')),
    drained = f.events(handle)
  await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce())
  await expect(handle.cancel('cancelled')).rejects.toBe(failure)
  await expect(handle.result).rejects.toBe(failure)
  await drained
  expect(f.gatewayDisposed).toHaveBeenCalledOnce()
  expect(vi.mocked(rm).mock.calls.some(([path]) => isImageTurnDirectory(path))).toBe(true)
  await expect(f.runtime.run(f.input, f.context('retired'))).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
})

it.each([
  ['/tmp/state/images/turn-abc123', true],
  [String.raw`C:\Users\runner\AppData\Local\Temp\state\images\turn-abc123`, true],
  ['C:/Users/runner/AppData/Local/Temp/state/images/turn-abc123', true],
  [String.raw`C:\Users\runner\AppData\Local\Temp\fixture`, false],
  ['/tmp/state/native-home', false],
] as const)('targets the image cleanup fault for either platform path: %s', (path, expected) => {
  expect(isImageTurnDirectory(path)).toBe(expected)
})
