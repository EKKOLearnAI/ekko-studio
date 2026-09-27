import { resolve } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PRESET_WORKSPACE_PROBE_MAX_IN_FLIGHT,
  PRESET_WORKSPACE_PROBE_MAX_THREADS,
  createDirectoryProbe,
  describeSessionCategoryPresetStatus,
  normalizeSessionCategoryPreset,
  parseStoredSessionCategoryPreset,
  readStoredSessionCategoryPreset,
  isSecretLikeParamName,
  presetBaseUrlCarriesCredentials,
  SESSION_CATEGORY_PRESET_AGENTS,
} from '../../packages/server/src/modules/studio/services/session-category-preset'
import { AGENT_RUNTIMES } from '../../packages/server/src/modules/studio/contracts/agents/runtime'
import {
  PRESET_BASE_URLS_WITH_CREDENTIALS,
  PRESET_BASE_URLS_WITHOUT_CREDENTIALS,
  SAFE_PARAM_NAMES,
  SECRET_LIKE_PARAM_NAMES,
} from '../fixtures/preset-base-url-cases'

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
    expect(PRESET_WORKSPACE_PROBE_MAX_THREADS).toBeGreaterThanOrEqual(PRESET_WORKSPACE_PROBE_MAX_IN_FLIGHT)
    if (pool > 1) expect(PRESET_WORKSPACE_PROBE_MAX_THREADS).toBeLessThan(pool)
  })

  it('marks a stat hung past the stale limit as stale-busy: logged once, answered unknown at once, never restarted, and off the in-flight cap', async () => {
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
    // The stale stat leaves the in-flight slot (it keeps its thread), so another path is checked at once.
    await expect(probe('/work/app')).resolves.toBe(true)
    expect(statFn).toHaveBeenCalledTimes(2)

    // Once the old stat settles its answer is used; nothing is restarted.
    finish(directory)
    await vi.advanceTimersByTimeAsync(0)
    await expect(probe('/mnt/hung')).resolves.toBe(true)
    await expect(probe('/work/app')).resolves.toBe(true)
    expect(statFn).toHaveBeenCalledTimes(2)
    expect(onStale).toHaveBeenCalledTimes(1)
  })

  it('keeps checking healthy paths while two mounts are stale-busy: no queue wait, answer cached', async () => {
    vi.useFakeTimers()
    const hung = new Set([resolve('/mnt/hung-a'), resolve('/mnt/hung-b')])
    const statFn = vi.fn((path: string) => hung.has(path) ? new Promise<typeof directory>(() => {}) : Promise.resolve(directory))
    let clock = 0
    const probe = createDirectoryProbe({ statFn, timeoutMs: 500, maxInFlight: 2, maxThreads: 3, staleMs: 30_000, now: () => clock, onStale: vi.fn() })

    const hungChecks = Promise.all([probe('/mnt/hung-a'), probe('/mnt/hung-b')])
    await vi.advanceTimersByTimeAsync(500)
    await expect(hungChecks).resolves.toEqual([undefined, undefined])
    clock = 30_000

    // Answered without any timer advancing: the healthy path did not queue behind the hung ones.
    let answer: boolean | undefined | 'pending' = 'pending'
    void probe('/work/app').then((value) => { answer = value })
    await vi.advanceTimersByTimeAsync(0)
    expect(answer).toBe(true)
    expect(statFn).toHaveBeenCalledTimes(3)
    // Cached: no second stat.
    await expect(probe('/work/app')).resolves.toBe(true)
    expect(statFn).toHaveBeenCalledTimes(3)
  })

  it('answers new paths "unknown" at once, without a stat, once stale-busy stats hold every allowed thread', async () => {
    vi.useFakeTimers()
    const statFn = vi.fn((path: string) => path.startsWith(resolve('/mnt')) ? new Promise<typeof directory>(() => {}) : Promise.resolve(directory))
    let clock = 0
    const probe = createDirectoryProbe({ statFn, timeoutMs: 500, maxInFlight: 2, maxThreads: 2, staleMs: 30_000, now: () => clock, onStale: vi.fn() })

    const hungChecks = Promise.all([probe('/mnt/a'), probe('/mnt/b')])
    // A third path queues behind the two running stats.
    const queued = probe('/work/queued')
    await vi.advanceTimersByTimeAsync(100)
    clock = 30_000
    // The stale marking settles the queued caller at once instead of leaving it to time out.
    let fresh: boolean | undefined | 'pending' = 'pending'
    void probe('/work/app').then((value) => { fresh = value })
    await vi.advanceTimersByTimeAsync(0)
    expect(fresh).toBeUndefined()
    await expect(queued).resolves.toBeUndefined()
    expect(statFn).toHaveBeenCalledTimes(2)
    expect(probe.waiting()).toBe(2)
    await vi.advanceTimersByTimeAsync(400)
    await expect(hungChecks).resolves.toEqual([undefined, undefined])
    expect(vi.getTimerCount()).toBe(0)
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

  it('matches secret-like parameter names by whole word (split on non-alphanumerics and camelCase) or known compound', () => {
    for (const name of SECRET_LIKE_PARAM_NAMES) expect(isSecretLikeParamName(name), name).toBe(true)
    for (const name of SAFE_PARAM_NAMES) expect(isSecretLikeParamName(name), name).toBe(false)
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

  it('drops the API mode with a stored Base URL that fails the filter, and reports the drop', async () => {
    const stored = JSON.stringify({ agent: 'claude-code', provider: 'p', apiMode: 'anthropic_messages', baseUrl: 'https://gw.test/v1?api_key=sk' })
    expect(readStoredSessionCategoryPreset(stored)).toEqual({ preset: { agent: 'claude-code', provider: 'p' }, baseUrlDropped: true })
    // A Base URL that passes keeps its API mode; a preset without one reports nothing.
    const kept = JSON.stringify({ agent: 'claude-code', apiMode: 'anthropic_messages', baseUrl: 'https://gw.test/v1' })
    expect(readStoredSessionCategoryPreset(kept)).toEqual({
      preset: { agent: 'claude-code', apiMode: 'anthropic_messages', baseUrl: 'https://gw.test/v1' },
      baseUrlDropped: false,
    })
    expect(readStoredSessionCategoryPreset(JSON.stringify({ apiMode: 'chat_completions' })).baseUrlDropped).toBe(false)
    // Only the flag reaches the client, never the dropped value.
    const probe = vi.fn()
    await expect(describeSessionCategoryPresetStatus({ agent: 'claude-code' }, probe, { baseUrlDropped: true }))
      .resolves.toEqual({ base_url_dropped: true })
    await expect(describeSessionCategoryPresetStatus(null, probe, { baseUrlDropped: true }))
      .resolves.toEqual({ base_url_dropped: true })
    await expect(describeSessionCategoryPresetStatus({ agent: 'claude-code' }, probe)).resolves.toBeUndefined()
    expect(probe).not.toHaveBeenCalled()
  })

  it('accepts every New Chat agent from the runtime registry, including Cursor', () => {
    // Derived, not hand-listed: a runtime added later is a valid preset agent at once.
    expect(SESSION_CATEGORY_PRESET_AGENTS).toEqual(AGENT_RUNTIMES.map(runtime => (runtime === 'ekko' ? 'ekko-agent' : runtime)))
    expect(SESSION_CATEGORY_PRESET_AGENTS).toContain('cursor')
    expect(SESSION_CATEGORY_PRESET_AGENTS).not.toContain('ekko')
    for (const agent of SESSION_CATEGORY_PRESET_AGENTS) {
      expect(normalizeSessionCategoryPreset({ agent }), agent).toEqual({ agent })
    }
    expect(() => normalizeSessionCategoryPreset({ agent: 'ekko' })).toThrow(/Preset field agent is invalid/)
  })

  it('stores a Cursor preset with the same rules as the New Chat panel', () => {
    expect(normalizeSessionCategoryPreset({ agent: 'cursor', profile: 'default', workspace: '/p/app' }))
      .toEqual({ agent: 'cursor', profile: 'default', workspace: '/p/app' })
    // The panel offers MoA only to Hermes and a session preset only to DeepSeek Harness.
    expect(() => normalizeSessionCategoryPreset({ agent: 'cursor', modelKind: 'moa' })).toThrow(/MoA presets/)
    expect(() => normalizeSessionCategoryPreset({ agent: 'cursor', agentPreset: 'planner' })).toThrow(/Agent preset/)
    // A stored launch mode is kept as written (the panel ignores it: Cursor always runs global), and a
    // stored invalid combination drops only the offending field on read.
    expect(normalizeSessionCategoryPreset({ agent: 'cursor', agentMode: 'scoped' })).toEqual({ agent: 'cursor', agentMode: 'scoped' })
    expect(parseStoredSessionCategoryPreset(JSON.stringify({ agent: 'cursor', modelKind: 'moa', agentPreset: 'x', workspace: '/w' })))
      .toEqual({ agent: 'cursor', workspace: '/w' })
  })
})
