import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EkkoDatabaseManager,
  EkkoDiagnosticsRegistry,
  setupEkkoAgent,
  type ModelClient,
  type ModelRequest,
} from '../../packages/ekko-agent/src'

const temporaryDirectories: string[] = []
const execFileAsync = promisify(execFile)

async function revokeDirectoryWrite(directory: string): Promise<void> {
  await chmod(directory, 0o500)
  if (process.platform !== 'win32') return
  const user = process.env.USERNAME
  if (!user) throw new Error('USERNAME is required to revoke write access')
  await execFileAsync('icacls', [directory, '/deny', `${user}:(W)`])
}

async function restoreDirectoryWrite(directory: string): Promise<void> {
  if (process.platform === 'win32' && process.env.USERNAME) {
    await execFileAsync('icacls', [directory, '/remove:d', process.env.USERNAME])
  }
  await chmod(directory, 0o700)
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(temporaryDirectories.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )))
})

describe('Ekko capability recovery', () => {
  it('keeps Core and recovery tools available when Profile Skills cannot initialize', async () => {
    const root = await temporaryDirectory('ekko-recovery-skills-')
    const source = join(root, 'bundled-skills')
    const baseDirectory = join(root, 'home')
    const target = join(baseDirectory, '.ekko', 'skills', 'default')
    await mkdir(join(source, 'weather'), { recursive: true })
    await writeFile(join(source, 'weather', 'SKILL.md'), '# Weather\n', 'utf8')
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, 'blocks the Profile Skill directory', 'utf8')
    vi.stubEnv('EKKO_BUILTIN_SKILLS_DIR', source)

    const setup = setupEkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })
    const requests: ModelRequest[] = []
    const runtime = setup.createRuntime({
      modelClient: recordingClient(requests),
      memory: false,
      recoveryDirective: inactiveRecoveryDirective,
    })
    try {
      expect(setup.database.databasePath).toBe(setup.layout.databasePath)
      expect(setup.recovery.snapshot()).toMatchObject({
        coreAvailable: true,
        status: 'degraded',
        active: [expect.objectContaining({
          component: 'skills',
          operation: 'profile.sync_bundled_skills',
          recovery: expect.objectContaining({ source, target }),
        })],
      })

      await runtime.run({ messages: ['Can you still answer?'] })
      const firstPrompt = String(requests[0].messages[0].content)
      expect(firstPrompt).toContain('Ekko Core is available')
      expect(firstPrompt).toContain(`source=${source}`)
      expect(firstPrompt).toContain(`target=${target}`)
      expect(firstPrompt).not.toContain('## Skill Discovery')
      expect(requests[0].tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'ekko_diagnostics' }),
        expect.objectContaining({ name: 'ekko_repair_skills' }),
        expect.objectContaining({ name: 'ekko_self_check' }),
      ]))

      const failedRepair = await setup.tool.execute('ekko_repair_skills', {}, { profileId: 'default' })
      expect(failedRepair.ok).toBe(false)
      expect(setup.recovery.snapshot().active).toEqual([
        expect.objectContaining({ component: 'skills', status: 'active' }),
      ])

      await rm(target)
      const repaired = await setup.tool.execute('ekko_repair_skills', {}, { profileId: 'default' })
      expect(repaired).toMatchObject({ ok: true, data: { ok: true, targetDirectory: target } })
      expect(setup.recovery.snapshot().status).toBe('ok')

      await runtime.run({ messages: ['Use Skills again.'] })
      const secondPrompt = String(requests[1].messages[0].content)
      expect(secondPrompt).not.toContain('Ekko Core is available, but optional capabilities are degraded.')
      expect(secondPrompt).toContain('## Skill Discovery')

      setup.recovery.recordMemoryFailure('runtime.memory_operation', new Error('temporary recall failure'))
      expect(setup.recovery.snapshot().active).toEqual([
        expect.objectContaining({ component: 'memory', message: 'temporary recall failure' }),
      ])
      await expect(setup.tool.execute('ekko_self_check', { component: 'memory' }, {
        profileId: 'default',
      })).resolves.toMatchObject({ ok: true, data: { ok: true, component: 'memory' } })
      expect(setup.recovery.snapshot().active).toEqual([])
    } finally {
      setup.close()
    }
  })

  it('keeps Core available when Profile Logs cannot initialize and resumes logging after repair', async () => {
    const baseDirectory = await temporaryDirectory('ekko-recovery-logs-')
    const initial = setupEkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })
    const logsDirectory = initial.layout.logsDirectory
    const profileLogsDirectory = initial.default.layout.logDirectory
    initial.close()
    await rm(logsDirectory, { recursive: true })
    await writeFile(logsDirectory, 'blocks the Ekko Logs directory', 'utf8')

    const setup = setupEkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })
    const requests: ModelRequest[] = []
    const runtime = setup.createRuntime({
      modelClient: recordingClient(requests),
      memory: false,
      recoveryDirective: inactiveRecoveryDirective,
    })
    try {
      expect(setup.recovery.snapshot()).toMatchObject({
        coreAvailable: true,
        status: 'degraded',
        active: [expect.objectContaining({
          component: 'logs',
          scope: 'profile:default',
          recovery: expect.objectContaining({
            tool: 'ekko_repair_logs',
            target: profileLogsDirectory,
          }),
        })],
      })

      await expect(runtime.run({ messages: ['Can Core still answer without file logs?'] }))
        .resolves.toMatchObject({ output: { content: 'Core response' } })
      expect(requests[0].tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'ekko_repair_logs' }),
        expect.objectContaining({ name: 'ekko_self_check' }),
      ]))

      await expect(setup.tool.execute('ekko_repair_logs', {}, { profileId: 'default' }))
        .resolves.toMatchObject({ ok: false })

      await rm(logsDirectory)
      await expect(setup.tool.execute('ekko_repair_logs', {}, { profileId: 'default' }))
        .resolves.toMatchObject({
          ok: true,
          data: {
            ok: true,
            targetDirectory: profileLogsDirectory,
            selfCheck: { ok: true, component: 'logs' },
          },
        })
      expect(setup.recovery.snapshot().status).toBe('ok')
      expect(setup.default.log.write({ category: 'system', event: 'logs.recovered' })).toBe(true)
      expect(setup.default.log.query({ event: 'logs.recovered' })).toHaveLength(1)
    } finally {
      setup.close()
    }
  })

  it('falls back to ephemeral SQLite and repairs the persistent target with migrations', async () => {
    const baseDirectory = await temporaryDirectory('ekko-recovery-database-')
    const databasePath = join(baseDirectory, '.ekko', 'ekko.db')
    const ekkoRoot = join(baseDirectory, '.ekko')
    const initial = setupEkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })
    initial.close()
    await rm(databasePath)
    await mkdir(databasePath, { recursive: true })
    await revokeDirectoryWrite(ekkoRoot)

    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const setup = setupEkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })
    const requests: ModelRequest[] = []
    const runtime = setup.createRuntime({
      modelClient: recordingClient(requests),
      memory: false,
      recoveryDirective: inactiveRecoveryDirective,
    })
    try {
      expect(setup.database.databasePath).toBe(':memory:')
      expect(setup.recovery.snapshot()).toMatchObject({
        coreAvailable: true,
        status: 'degraded',
        capabilities: {
          database: {
            targetPath: databasePath,
            activeStorage: 'ephemeral',
            targetReady: false,
          },
        },
        active: [expect.objectContaining({
          component: 'database',
          operation: 'startup.initialize_persistent_database',
          metadata: expect.objectContaining({ activeStorage: 'ephemeral' }),
        })],
      })

      await runtime.run({ messages: ['Keep talking without persistent memory.'] })
      const prompt = String(requests[0].messages[0].content)
      expect(prompt).toContain('Persistent Ekko memory and conversation storage are unavailable')
      expect(prompt).toContain(`target=${databasePath}`)
      expect(prompt).toContain('schemaOwner=ekko-agent compiled migrations')
      expect(prompt).toContain('schemaTable=memory_nodes fields=row_id,id,parent_id')
      expect(prompt).toContain('schemaTable=sessions fields=id,profile,source')

      const retryWhileBlocked = await setup.tool.execute('ekko_repair_database', { strategy: 'retry' })
      expect(retryWhileBlocked.ok).toBe(false)
      expect(setup.recovery.snapshot().active).toEqual([
        expect.objectContaining({ component: 'database', operation: 'repair.retry' }),
      ])

      await restoreDirectoryWrite(ekkoRoot)
      await rm(databasePath, { recursive: true })
      const repaired = await setup.tool.execute('ekko_repair_database', { strategy: 'retry' })
      expect(repaired).toMatchObject({
        ok: true,
        data: {
          ok: true,
          strategy: 'retry',
          restartRequired: true,
          selfCheck: { ok: true, component: 'database' },
        },
      })
      expect(setup.recovery.snapshot()).toMatchObject({
        status: 'degraded',
        active: [],
        capabilities: {
          database: {
            activeStorage: 'ephemeral',
            targetReady: true,
            restartRequired: true,
          },
        },
      })

      const schema = await setup.tool.execute('ekko_database_schema', {})
      expect(schema).toMatchObject({
        ok: true,
        data: {
          owner: 'ekko-agent compiled migrations (memory@8, conversations@1)',
          tables: {
            memory_nodes: expect.arrayContaining(['scope_type', 'key', 'content']),
            sessions: expect.arrayContaining(['id', 'profile', 'history_revision']),
          },
        },
      })

      await runtime.run({ messages: ['What remains?'] })
      expect(String(requests[1].messages[0].content)).toContain(
        'Ekko Studio will automatically reload Ekko Setup after all active runs finish',
      )
    } finally {
      await restoreDirectoryWrite(ekkoRoot)
      setup.close()
      warning.mockRestore()
    }
  })

  it('does not let a stale self-check clear a newer incident revision', () => {
    const diagnostics = new EkkoDiagnosticsRegistry()
    const first = diagnostics.report(diagnosticInput(new Error('first failure')))
    const duplicate = diagnostics.report(diagnosticInput(new Error('first failure')))
    expect(duplicate.incidentId).toBe(first.incidentId)
    expect(duplicate.revision).toBe(first.revision)
    const second = diagnostics.report(diagnosticInput(new Error('second failure')))
    const check = {
      ok: true,
      component: 'skills' as const,
      checkedAt: new Date().toISOString(),
      checks: [{ name: 'test', ok: true, detail: 'ok' }],
    }

    expect(diagnostics.resolve('skills', 'global', check, first.incidentId)).toBe(false)
    expect(diagnostics.get('skills', 'global')?.incidentId).toBe(second.incidentId)
    expect(diagnostics.resolve('skills', 'global', check, second.incidentId)).toBe(true)
    expect(diagnostics.snapshot().active).toEqual([])
  })

  it('requires approval for rebuild and recovers compatible data before reindexing', async () => {
    const baseDirectory = await temporaryDirectory('ekko-recovery-rebuild-')
    const ekkoRoot = join(baseDirectory, '.ekko')
    const initial = setupEkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })
    const memory = await initial.memory.create({
      kind: 'general_preference',
      itemKey: 'rebuild_recovery',
      reason: 'recovery test',
      explicitUserIntent: true,
      identity: { sessionId: 'rebuild-session', profileId: 'default' },
      node: { title: 'Recovered memory', content: 'Preserve through the repair tool.' },
    })
    initial.conversations.createSession({ id: 'rebuild-session', title: 'Recovered session' })
    initial.close()

    const databasePath = join(ekkoRoot, 'ekko.db')
    const malformed = new EkkoDatabaseManager({ databasePath, env: { NODE_ENV: 'test' } })
    malformed.connection.exec(`
      ALTER TABLE schema_migrations RENAME TO schema_migrations_original;
      CREATE TABLE schema_migrations (component TEXT PRIMARY KEY);
    `)
    malformed.close()
    await revokeDirectoryWrite(ekkoRoot)

    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const degraded = setupEkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })
    try {
      expect(degraded.database.databasePath).toBe(':memory:')
      await restoreDirectoryWrite(ekkoRoot)

      await expect(degraded.tool.execute('ekko_repair_database', {
        strategy: 'rebuild',
        confirmed: true,
      })).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining('requires approval'),
      })

      const requestToolApproval = vi.fn(async () => 'once' as const)
      await expect(degraded.tool.execute('ekko_repair_database', {
        strategy: 'rebuild',
        confirmed: true,
      }, {
        sessionId: 'rebuild-session',
        requestToolApproval,
      })).resolves.toMatchObject({
        ok: true,
        data: {
          ok: true,
          strategy: 'rebuild',
          backupPath: expect.stringContaining('.migration-failed-'),
          recoveredTables: expect.arrayContaining([
            expect.objectContaining({ table: 'memory_nodes' }),
            expect.objectContaining({ table: 'sessions' }),
          ]),
          restartRequired: true,
          selfCheck: { ok: true },
        },
      })
      expect(requestToolApproval).toHaveBeenCalledWith(expect.objectContaining({
        toolName: 'ekko_repair_database',
        key: 'ekko:database-rebuild',
      }))

      const recovered = setupEkkoAgent({ baseDirectory, env: { NODE_ENV: 'test' } })
      try {
        await expect(recovered.memory.get(memory.nodeId!, { profileId: 'default' }))
          .resolves.toMatchObject({ title: 'Recovered memory' })
        expect(recovered.conversations.getSession('rebuild-session'))
          .toMatchObject({ title: 'Recovered session' })
        expect(recovered.database.connection.prepare(
          "SELECT count(*) AS count FROM memory_nodes_fts WHERE node_id = ?",
        ).get(memory.nodeId)).toMatchObject({ count: 1 })
      } finally {
        recovered.close()
      }
    } finally {
      await restoreDirectoryWrite(ekkoRoot)
      degraded.close()
      warning.mockRestore()
    }
  })
})

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function recordingClient(requests: ModelRequest[]): ModelClient {
  return {
    provider: 'recovery-test',
    requestStyle: 'openai-chat',
    capabilities: {
      streaming: false,
      tools: true,
      vision: false,
      jsonMode: false,
      systemPrompt: true,
    },
    async create(request) {
      requests.push(request)
      return { content: 'Core response' }
    },
    async *stream() {},
  }
}

function inactiveRecoveryDirective() {
  return { active: false, automaticToolCalls: [], allowedToolNames: [], reminder: '' }
}

function diagnosticInput(error: Error) {
  return {
    component: 'skills' as const,
    operation: 'test',
    error,
    effect: 'test',
    recovery: {
      tool: 'ekko_repair_skills',
      summary: 'test',
      steps: ['test'],
      automatic: true,
    },
  }
}
