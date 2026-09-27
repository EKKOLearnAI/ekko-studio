import { resolve } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PRESET_WORKSPACE_PROBE_MAX_IN_FLIGHT,
  createDirectoryProbe,
  describeSessionCategoryPresetStatus,
  normalizeSessionCategoryPreset,
  parseStoredSessionCategoryPreset,
  isSecretLikeParamName,
  presetBaseUrlCarriesCredentials,
} from '../../packages/server/src/modules/studio/services/session-category-preset'
import { PRESET_BASE_URLS_WITH_CREDENTIALS, PRESET_BASE_URLS_WITHOUT_CREDENTIALS } from '../fixtures/preset-base-url-cases'

const directory = { isDirectory: () => true }
const file = { isDirectory: () => false }

function errno(code: string) {
  return Object.assign(new Error(code), { code })
}

describe('session category preset workspace probe', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('treats a hung folder check as unknown after the timeout instead of blocking or reporting it missing', async () => {
    vi.useFakeTimers()
    const probe = createDirectoryProbe({ statFn: () => new Promise(() => {}), timeoutMs: 50 })
    const pending = describeSessionCategoryPresetStatus({ workspace: '/mnt/slow-share' }, probe)
    await vi.advanceTimersByTimeAsync(50)
    await expect(pending).resolves.toBeUndefined()
  })

  it('reports missing folders as false and other stat errors as unknown', async () => {
    const statFn = vi.fn()
      .mockResolvedValueOnce(directory)
      .mockResolvedValueOnce(file)
      .mockRejectedValueOnce(errno('ENOENT'))
      .mockRejectedValueOnce(errno('EACCES'))
    const probe = createDirectoryProbe({ statFn })
    await expect(probe('/work/app')).resolves.toBe(true)
    await expect(probe('/work/file.txt')).resolves.toBe(false)
    await expect(probe('/work/deleted')).resolves.toBe(false)
    await expect(probe('/root/secret')).resolves.toBeUndefined()
  })

  it('never starts a second stat for a path while one is pending, even after the caller timed out', async () => {
    vi.useFakeTimers()
    let finish!: (value: typeof directory) => void
    const statFn = vi.fn(() => new Promise<typeof directory>((done) => { finish = done }))
    const probe = createDirectoryProbe({ statFn, timeoutMs: 100 })

    const first = probe('/mnt/share')
    const second = probe('/mnt/share')
    await vi.advanceTimersByTimeAsync(100)
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
    // Drawer reopened while the hung stat is still running: it joins, no new stat.
    const third = probe('/mnt/share')
    expect(statFn).toHaveBeenCalledTimes(1)

    finish(directory)
    await expect(third).resolves.toBe(true)
    expect(statFn).toHaveBeenCalledTimes(1)
  })

  it('caches answers for the TTL, then checks again', async () => {
    let clock = 1_000
    const statFn = vi.fn()
      .mockResolvedValueOnce(directory)
      .mockRejectedValueOnce(errno('ENOENT'))
    const probe = createDirectoryProbe({ statFn, ttlMs: 30_000, now: () => clock })

    await expect(probe('/work/app')).resolves.toBe(true)
    clock += 29_999
    await expect(probe('/work/app')).resolves.toBe(true)
    expect(statFn).toHaveBeenCalledTimes(1)

    clock += 1
    await expect(probe('/work/app')).resolves.toBe(false)
    expect(statFn).toHaveBeenCalledTimes(2)
  })

  it('caps concurrent stats; a path queued beyond the cap answers "unknown" on timeout without ever starting', async () => {
    vi.useFakeTimers()
    const statFn = vi.fn(() => new Promise<typeof directory>(() => {}))
    const probe = createDirectoryProbe({ statFn, timeoutMs: 100, maxInFlight: 2 })

    const results = Promise.all([probe('/a'), probe('/b'), probe('/c')])
    expect(statFn).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(100)
    await expect(results).resolves.toEqual([undefined, undefined, undefined])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(statFn).toHaveBeenCalledTimes(2)
  })

  it('queues healthy paths beyond the cap so every category of a listing still gets an answer', async () => {
    vi.useFakeTimers()
    const statFn = vi.fn((path: string) => (path === resolve('/gone') ? Promise.reject(errno('ENOENT')) : Promise.resolve(directory)))
    const probe = createDirectoryProbe({ statFn, timeoutMs: 100, maxInFlight: 2 })
    const all = Promise.all(['/a', '/b', '/c', '/gone', '/e'].map(workspace => describeSessionCategoryPresetStatus({ workspace }, probe)))
    await vi.advanceTimersByTimeAsync(0)
    await expect(all).resolves.toEqual([
      { workspace_exists: true },
      { workspace_exists: true },
      { workspace_exists: true },
      { workspace_exists: false },
      { workspace_exists: true },
    ])
    expect(statFn).toHaveBeenCalledTimes(5)
  })

  it('runs checks for different paths in parallel, so one slow folder does not delay the others', async () => {
    vi.useFakeTimers()
    const statFn = vi.fn((path: string) => path === resolve('/slow')
      ? new Promise<typeof directory>(() => {})
      : Promise.resolve(directory))
    const probe = createDirectoryProbe({ statFn, timeoutMs: 100 })
    const all = Promise.all([
      describeSessionCategoryPresetStatus({ workspace: '/slow' }, probe),
      describeSessionCategoryPresetStatus({ workspace: '/fast-a' }, probe),
      describeSessionCategoryPresetStatus({ workspace: '/fast-b' }, probe),
    ])
    await vi.advanceTimersByTimeAsync(100)
    expect(statFn).toHaveBeenCalledTimes(3)
    await expect(all).resolves.toEqual([undefined, { workspace_exists: true }, { workspace_exists: true }])
  })

  it('keeps the default stat cap below the libuv threadpool size', () => {
    const pool = Number(process.env.UV_THREADPOOL_SIZE) || 4
    expect(PRESET_WORKSPACE_PROBE_MAX_IN_FLIGHT).toBeLessThan(pool)
    expect(PRESET_WORKSPACE_PROBE_MAX_IN_FLIGHT).toBeGreaterThanOrEqual(1)
  })

  it('marks a stat hung past the stale limit as stale-busy: logged once, answered unknown at once, still counted, never restarted', async () => {
    vi.useFakeTimers()
    let finish!: (value: typeof directory) => void
    const statFn = vi.fn((path: string) => path === resolve('/mnt/hung')
      ? new Promise<typeof directory>((done) => { finish = done })
      : Promise.resolve(directory))
    const onStale = vi.fn()
    let clock = 0
    const probe = createDirectoryProbe({ statFn, timeoutMs: 100, maxInFlight: 1, staleMs: 30_000, now: () => clock, onStale })

    const first = probe('/mnt/hung')
    await vi.advanceTimersByTimeAsync(100)
    await expect(first).resolves.toBeUndefined()

    clock = 30_000
    // Stale: no wait, no second stat on the hung mount, logged once.
    await expect(probe('/mnt/hung')).resolves.toBeUndefined()
    await expect(probe('/mnt/hung')).resolves.toBeUndefined()
    expect(onStale).toHaveBeenCalledTimes(1)
    expect(onStale).toHaveBeenCalledWith(resolve('/mnt/hung'), 30_000)
    // The stale stat still holds its slot, so a new path is not stacked on the threadpool.
    const queued = probe('/work/app')
    await vi.advanceTimersByTimeAsync(100)
    await expect(queued).resolves.toBeUndefined()
    expect(statFn).toHaveBeenCalledTimes(1)

    // Once the old stat settles its answer is used and the slot frees up.
    finish(directory)
    await vi.advanceTimersByTimeAsync(0)
    await expect(probe('/mnt/hung')).resolves.toBe(true)
    await expect(probe('/work/app')).resolves.toBe(true)
    expect(statFn).toHaveBeenCalledTimes(2)
    expect(onStale).toHaveBeenCalledTimes(1)
  })

  it('keeps waiters bounded while a mount hangs: each timed-out caller is removed', async () => {
    vi.useFakeTimers()
    let finish!: (value: typeof directory) => void
    const statFn = vi.fn(() => new Promise<typeof directory>((done) => { finish = done }))
    const probe = createDirectoryProbe({ statFn, timeoutMs: 100, staleMs: Number.POSITIVE_INFINITY, onStale: vi.fn() })

    for (let round = 0; round < 50; round += 1) {
      const callers = Array.from({ length: 20 }, () => probe('/mnt/hung'))
      expect(probe.waiting()).toBe(20)
      await vi.advanceTimersByTimeAsync(100)
      await expect(Promise.all(callers)).resolves.toEqual(Array(20).fill(undefined))
      // 1000 callers joined over time, but none is still held by the hung stat.
      expect(probe.waiting()).toBe(0)
    }
    expect(statFn).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)

    const late = probe('/mnt/hung')
    finish(directory)
    await expect(late).resolves.toBe(true)
    expect(probe.waiting()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('probes a relative workspace where a chat run would use it (the server working directory)', async () => {
    const statFn = vi.fn().mockResolvedValue(directory)
    const probe = createDirectoryProbe({ statFn })
    await expect(describeSessionCategoryPresetStatus({ workspace: 'projects/app' }, probe))
      .resolves.toEqual({ workspace_exists: true })
    expect(statFn).toHaveBeenCalledWith(resolve(process.cwd(), 'projects/app'))
    // Same folder spelled differently shares one cache entry.
    await probe('./projects/app')
    expect(statFn).toHaveBeenCalledTimes(1)
  })
})

describe('session category preset validation', () => {
  it('stores relative workspaces as entered, like the New Chat panel', () => {
    for (const workspace of ['projects/app', './here', '~/app', 'C:work', '/abs/app', 'C:\\work']) {
      expect(normalizeSessionCategoryPreset({ workspace })).toEqual({ workspace })
    }
    expect(parseStoredSessionCategoryPreset(JSON.stringify({ workspace: 'projects/app', model: 'm' })))
      .toEqual({ model: 'm', workspace: 'projects/app' })
  })

  it('detects credentials embedded in a Base URL, including WHATWG userinfo without //', () => {
    for (const url of PRESET_BASE_URLS_WITH_CREDENTIALS) expect(presetBaseUrlCarriesCredentials(url), url).toBe(true)
    for (const url of PRESET_BASE_URLS_WITHOUT_CREDENTIALS) expect(presetBaseUrlCarriesCredentials(url), url).toBe(false)
  })

  it('matches secret-like parameter names case-, dash- and underscore-insensitively by substring', () => {
    for (const name of ['x-api-key', 'Subscription-Key', 'client_secret', 'AUTH', 'api_key[]', '%61pi_key', 'access-token', 'passwd', 'signature', 'keyboard'])
      expect(isSecretLikeParamName(name), name).toBe(true)
    for (const name of ['api-version', 'version', 'region', 'format', 'deployment', 'model'])
      expect(isSecretLikeParamName(name), name).toBe(false)
  })

  it('refuses a Base URL with credentials on write and drops it on read', () => {
    expect(() => normalizeSessionCategoryPreset({ agent: 'claude-code', baseUrl: 'https://u:p@gw.test' }))
      .toThrow(/Base URL cannot contain credentials/)
    expect(() => normalizeSessionCategoryPreset({ agent: 'claude-code', baseUrl: 'https://gw.test/?api_key=sk' }))
      .toThrow(/Base URL cannot contain credentials/)
    expect(() => normalizeSessionCategoryPreset({ agent: 'claude-code', baseUrl: 'https:u:p@gw.test/v1' }))
      .toThrow(/Base URL cannot contain credentials/)
    expect(normalizeSessionCategoryPreset({ agent: 'claude-code', baseUrl: 'https://x.openai.azure.com/openai/deployments/d?api-version=2024-10-21' }))
      .toEqual({ agent: 'claude-code', baseUrl: 'https://x.openai.azure.com/openai/deployments/d?api-version=2024-10-21' })
    expect(parseStoredSessionCategoryPreset(JSON.stringify({ model: 'm', baseUrl: 'https://gw.test/?token=t' })))
      .toEqual({ model: 'm' })
  })
})
