import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EkkoFileLogReader, EkkoFileLogger } from '../../packages/ekko-agent/src'

const mocks = vi.hoisted(() => ({
  appHome: `/tmp/hermes-web-ui-logs-controller-${process.pid}`,
  listLogFiles: vi.fn(async () => []),
  readLogs: vi.fn(async () => ''),
  hermesAvailable: true,
}))

vi.mock('../../packages/server/src/modules/studio/public/config', () => ({
  config: { appHome: mocks.appHome },
}))

vi.mock('../../packages/server/src/modules/studio/public/agent-logs', () => ({
  listPrimaryAgentLogFiles: mocks.listLogFiles,
  readPrimaryAgentLogs: mocks.readLogs,
  getEkkoLogSource: (profile: string) => {
    const directory = join(mocks.appHome, '.ekko', 'logs', profile)
    return new EkkoFileLogReader({ directory })
  },
}))

vi.mock('../../packages/server/src/modules/studio/public/agent-status-registry', () => ({
  isHermesAgentAvailable: vi.fn(() => mocks.hermesAvailable),
}))

describe('Hermes logs controller Ekko source', () => {
  beforeAll(async () => {
    await rm(mocks.appHome, { recursive: true, force: true })
    await mkdir(mocks.appHome, { recursive: true })
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.hermesAvailable = true
  })

  afterAll(async () => {
    await rm(mocks.appHome, { recursive: true, force: true })
  })

  it('lists and reads the current profile Ekko log through the existing logs API', async () => {
    const directory = join(mocks.appHome, '.ekko', 'logs', 'work')
    const logger = new EkkoFileLogger({ directory })
    logger.write({
      category: 'model',
      event: 'model.started',
      profile: 'work',
      sessionId: 'session-other',
      runId: 'run-other',
    })
    logger.write({
      category: 'tool',
      event: 'tool.failed',
      level: 'warn',
      profile: 'work',
      sessionId: 'session-target',
      runId: 'run-target',
      data: { error: 'timed out' },
    })

    const controller = await import('../../packages/server/src/modules/studio/controllers/logs')
    const listContext: any = {
      state: { profile: { name: 'work' } },
      query: {},
      body: null,
    }
    await controller.list(listContext)
    expect(listContext.body.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'ekko-agent' }),
    ]))

    const readContext: any = {
      state: { profile: { name: 'work' } },
      params: { name: 'ekko-agent' },
      query: { lines: '100', session: 'session-target', level: 'WARNING' },
      body: null,
    }
    await controller.read(readContext)

    expect(readContext.body.entries).toHaveLength(1)
    expect(readContext.body.entries[0]).toMatchObject({
      level: 'WARNING',
      logger: 'ekko-agent/tool',
    })
    expect(readContext.body.entries[0].message).toContain('tool.failed')
    expect(readContext.body.entries[0].message).toContain('session=session-target')
  })

  it('keeps Studio logs but does not query Hermes logs when Hermes is unavailable', async () => {
    mocks.hermesAvailable = false
    const controller = await import('../../packages/server/src/modules/studio/controllers/logs')
    const listContext: any = { state: { profile: { name: 'work' } }, query: {}, body: null }

    await controller.list(listContext)

    expect(mocks.listLogFiles).not.toHaveBeenCalled()
    expect(listContext.body.files.map((file: any) => file.name)).not.toContain('agent')

    const readContext: any = {
      params: { name: 'agent' },
      query: { lines: '100' },
      body: null,
    }
    await controller.read(readContext)

    expect(mocks.readLogs).not.toHaveBeenCalled()
    expect(readContext.body).toEqual({ entries: [], count: 0, truncated: false })
  })

  it.each<string>(['1h', '30m', '2d'])('accepts relative since %s and omits raw by default', async (since: string) => {
    const controller = await import('../../packages/server/src/modules/studio/controllers/logs')
    const readContext: any = {
      state: { profile: { name: 'work' } },
      params: { name: 'ekko-agent' },
      query: { since, lines: '10' },
      body: null,
    }
    await controller.read(readContext)
    expect(readContext.status).not.toBe(400)
    expect(readContext.body).toEqual(expect.objectContaining({ count: expect.any(Number), truncated: expect.any(Boolean) }))
    expect(readContext.body.entries.every((entry: any) => !('raw' in entry))).toBe(true)
  })

  it('accepts ISO since and rejects invalid since with HTTP 400', async () => {
    const controller = await import('../../packages/server/src/modules/studio/controllers/logs')
    const valid: any = { state: { profile: { name: 'work' } }, params: { name: 'ekko-agent' }, query: { since: '2026-10-09T00:00:00.123Z' }, body: null }
    await controller.read(valid)
    expect(valid.status).not.toBe(400)

    const invalid: any = { state: { profile: { name: 'work' } }, params: { name: 'ekko-agent' }, query: { since: 'not-a-time' }, body: null }
    await controller.read(invalid)
    expect(invalid.status).toBe(400)
    expect(invalid.body.error).toContain('Invalid since')
  })

  it('limits structured responses, omits raw by default, and exposes a usable cursor', async () => {
    const directory = join(mocks.appHome, '.ekko', 'logs', 'work')
    const logger = new EkkoFileLogger({ directory })
    for (let i = 0; i < 4; i++) {
      logger.write({ category: 'run', event: `run.${i}`, profile: 'work', sessionId: 's', runId: `r-${i}` })
    }
    const controller = await import('../../packages/server/src/modules/studio/controllers/logs')
    const first: any = { state: { profile: { name: 'work' } }, params: { name: 'ekko-agent' }, query: { session: 's', lines: '2' }, body: null }
    await controller.read(first)
    expect(first.body.entries).toHaveLength(2)
    expect(first.body.truncated).toBe(true)
    expect(first.body.next_cursor).toEqual(expect.any(String))
    expect(first.body.entries.every((entry: any) => !('raw' in entry))).toBe(true)

    const second: any = { state: { profile: { name: 'work' } }, params: { name: 'ekko-agent' }, query: { session: 's', lines: '2', cursor: first.body.next_cursor }, body: null }
    await controller.read(second)
    expect(second.body.entries.map((entry: any) => entry.message)).not.toEqual(expect.arrayContaining(first.body.entries.map((entry: any) => entry.message)))
  })

  it('preserves millisecond precision for ISO since boundaries', async () => {
    const directory = join(mocks.appHome, '.ekko', 'logs', 'work')
    let tick = 122
    const logger = new EkkoFileLogger({ directory, now: () => new Date(`2026-10-09T00:00:00.${String(tick++).padStart(3, '0')}Z`) })
    logger.write({ category: 'run', event: 'before-boundary', profile: 'work', sessionId: 'boundary' })
    logger.write({ category: 'run', event: 'at-boundary', profile: 'work', sessionId: 'boundary', data: { exact: true } })
    const controller = await import('../../packages/server/src/modules/studio/controllers/logs')
    const context: any = {
      state: { profile: { name: 'work' } },
      params: { name: 'ekko-agent' },
      query: { session: 'boundary', since: '2026-10-09T00:00:00.123Z', lines: '10' },
      body: null,
    }
    await controller.read(context)
    expect(context.body.entries).toHaveLength(1)
    expect(context.body.entries[0].message).toContain('at-boundary')
  })
})
