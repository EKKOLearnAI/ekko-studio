import { resolve } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDirectoryProbe,
  describeSessionCategoryPresetStatus,
  normalizeSessionCategoryPreset,
  parseStoredSessionCategoryPreset,
  presetBaseUrlCarriesCredentials,
} from '../../packages/server/src/modules/studio/services/session-category-preset'

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

  it('caps concurrent stats and answers "unknown" beyond the cap without starting another', async () => {
    vi.useFakeTimers()
    const statFn = vi.fn(() => new Promise<typeof directory>(() => {}))
    const probe = createDirectoryProbe({ statFn, timeoutMs: 100, maxInFlight: 2 })

    const results = Promise.all([probe('/a'), probe('/b'), probe('/c')])
    expect(statFn).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(100)
    await expect(results).resolves.toEqual([undefined, undefined, undefined])
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
    // Every stat starts before any timer fires.
    expect(statFn).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(100)
    await expect(all).resolves.toEqual([undefined, { workspace_exists: true }, { workspace_exists: true }])
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

  it('detects credentials embedded in a Base URL', () => {
    for (const url of [
      'https://user:pass@gateway.test/v1',
      'https://token@gateway.test/v1',
      'user:pass@localhost:11434/v1',
      'https://gateway.test/v1?api_key=sk-1',
      'https://gateway.test/v1?x=1&KEY=abc',
      'https://gateway.test/v1?Access_Token=abc',
      'https://gateway.test/v1?api-key=abc',
      'https://gateway.test/v1?sig=abc',
      'https://gateway.test/v1?password=abc',
      'https://gateway.test/v1?secret=abc',
      'https://gateway.test/v1?token=abc',
      'https://gateway.test/v1?apikey=abc',
    ]) expect(presetBaseUrlCarriesCredentials(url), url).toBe(true)
    for (const url of [
      'https://gateway.test/v1',
      'localhost:11434/v1',
      'ftp://example.test',
      'https://gateway.test/v1?region=eu&keyboard=1&monkey=2',
      'https://gateway.test/tokens/v1',
    ]) expect(presetBaseUrlCarriesCredentials(url), url).toBe(false)
  })

  it('refuses a Base URL with credentials on write and drops it on read', () => {
    expect(() => normalizeSessionCategoryPreset({ agent: 'claude-code', baseUrl: 'https://u:p@gw.test' }))
      .toThrow(/Base URL cannot contain credentials/)
    expect(() => normalizeSessionCategoryPreset({ agent: 'claude-code', baseUrl: 'https://gw.test/?api_key=sk' }))
      .toThrow(/Base URL cannot contain credentials/)
    expect(parseStoredSessionCategoryPreset(JSON.stringify({ model: 'm', baseUrl: 'https://gw.test/?token=t' })))
      .toEqual({ model: 'm' })
  })
})
