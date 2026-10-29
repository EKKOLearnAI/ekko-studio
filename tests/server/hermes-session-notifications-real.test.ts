import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// Opt-in: runs against a real, read-only Hermes Agent checkout with isolated homes.
//   HERMES_REAL_BRIDGE_E2E=1 HERMES_AGENT_ROOT=<checkout> npx vitest run tests/server/hermes-session-notifications-real.test.ts
const agentRoot = process.env.HERMES_AGENT_ROOT || ''
const python = process.env.HERMES_REAL_PYTHON || join(agentRoot, 'venv', 'bin', 'python')
const enabled = process.env.HERMES_REAL_BRIDGE_E2E === '1' && Boolean(agentRoot) && existsSync(python)

const execFileAsync = promisify(execFile)

async function runCase(name: string): Promise<any> {
  const root = mkdtempSync(join(tmpdir(), 'hermes-sn-real-'))
  try {
    for (const dir of ['home', 'hermes', 'studio', 'pycache']) mkdirSync(join(root, dir), { recursive: true })
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: join(root, 'home'),
      HERMES_HOME: join(root, 'hermes'),
      HERMES_AGENT_ROOT: agentRoot,
      PYTHONDONTWRITEBYTECODE: '1',
      // Reuse the checkout's read-only environment: no per-data-root dependency sync or relaunch.
      HERMES_DISABLE_LAZY_INSTALLS: '1',
      ...(process.env.HERMES_REAL_EXTRA_PYTHONPATH ? { PYTHONPATH: process.env.HERMES_REAL_EXTRA_PYTHONPATH } : {}),
      PYTHONPYCACHEPREFIX: join(root, 'pycache'),
      HERMES_AGENT_BRIDGE_STUDIO_NOTIFICATIONS: JSON.stringify({ bindings_db: join(root, 'studio', 'cron-bindings.db'), instance_id: 'inst-1' }),
    }
    // Async so the Vitest worker stays responsive while Hermes imports.
    const { stdout: output } = await execFileAsync(python, ['tests/server/fixtures/hermes-session-notifications-real.py', name], {
      cwd: process.cwd(), env, encoding: 'utf-8', timeout: 150_000, maxBuffer: 8 * 1024 * 1024,
    })
    const line = output.split('\n').find(entry => entry.startsWith('RESULT '))
    if (!line) throw new Error(`no result for ${name}:\n${output}`)
    return JSON.parse(line.slice('RESULT '.length))
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string }
    throw new Error([err.message, err.stdout && `stdout:\n${err.stdout}`, err.stderr && `stderr:\n${String(err.stderr).slice(-6000)}`]
      .filter(Boolean).join('\n\n'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe.skipIf(!enabled)('real Hermes: cron session binding', { timeout: 180_000 }, () => {
  it('binds an omitted-target create before activation, then resumes it with the native shape', async () => {
    const result = await runCase('cron_default')
    expect(result.created).toMatchObject({ success: true, deliver: 'local', studio_session_delivery: 'bound' })
    expect(result.created.message).not.toContain('Created PAUSED')
    expect(result.job).toMatchObject({ state: 'scheduled', enabled: true, deliver: 'local', origin: null })
    expect(result.bindings).toEqual([['inst-1', 'default', result.created.job_id, 'sess-A', 'local', 0, 'gen-A1']])
  })

  it('translates explicit origin to the exact Studio session, never a home-channel fallback', async () => {
    const result = await runCase('cron_origin')
    // failure_deliver is the user's explicit choice: preserved byte-for-byte, never rewritten by Studio.
    expect(result.job).toMatchObject({ state: 'scheduled', deliver: 'local', failure_deliver: 'origin', origin: null })
    expect(result.bindings).toHaveLength(1)
  })

  it('leaves explicit local and concrete targets untouched and unbound', async () => {
    const result = await runCase('cron_explicit')
    expect(result.local).toMatchObject({ deliver: 'local', state: 'scheduled' })
    expect(result.slack).toMatchObject({ deliver: 'slack:C123', failure_deliver: 'local' })
    expect(result.bindings).toEqual([])
  })

  it('preserves an explicit failure_deliver on a bound create', async () => {
    const result = await runCase('cron_failure_deliver_explicit')
    expect(result.job).toMatchObject({ deliver: 'local', failure_deliver: 'slack:C9', state: 'scheduled' })
    expect(result.bindings).toHaveLength(1)
  })

  it('refuses to bind without the owner session generation and leaves the job paused', async () => {
    const result = await runCase('cron_missing_generation')
    expect(result.created.success).toBe(false)
    expect(result.created.error).toContain('left paused')
    expect(result.job).toMatchObject({ state: 'paused', enabled: false })
    expect(result.bindings).toEqual([])
  })

  it('offers cronjob_manage to a freshly built Studio bridge agent without a global exec-ask override', async () => {
    const result = await runCase('fresh_agent_tools')
    expect(result.terminal_tool).toBe(true)
    expect(result.cron_tool).toBe(true)
    expect(result.cron_at_dispatch).toBe(true)
    expect(result.exec_ask_after).toBeNull()
  })

  it('R6: recovers more than one native page of executions exactly once in bounded passes', async () => {
    const result = await runCase('observe_pagination')
    expect(result.backlog).toBe(130)
    expect(result.late).toBe(3)
    expect(result.missing).toBe(0)
    expect(result.max_rows_per_pass).toBeLessThanOrEqual(100)
    expect(result.cursor_after).toBeNull()
  })

  it('keeps a requested paused job paused while binding it', async () => {
    const result = await runCase('cron_paused')
    expect(result.job).toMatchObject({ state: 'paused', enabled: false })
    expect(result.bindings).toHaveLength(1)
    expect(result.bindings[0][5]).toBe(1)
  })

  it('passes non-Studio calls straight through (legacy cronjob alias resolves to the wrapped entry)', async () => {
    const result = await runCase('cron_not_studio')
    expect(result.created.success).toBe(true)
    expect(result.created).not.toHaveProperty('studio_session_delivery')
    expect(result.bindings).toEqual([])
    expect(result.legacy_alias).toBe('cronjob_manage')
  })

  it('reports a binding failure and leaves the created job paused', async () => {
    const result = await runCase('cron_binding_failure')
    expect(result.created.success).toBe(false)
    expect(result.created.error).toContain('left paused')
    expect(result.job).toMatchObject({ state: 'paused', enabled: false })
  })
})

describe.skipIf(!enabled)('real Hermes: terminal notify_on_complete adapter', { timeout: 180_000 }, () => {
  it('delivers success and nonzero completions as typed machine events with native text, once', async () => {
    const result = await runCase('process_success_failure')
    expect(result.ok_result.notify_on_complete).toBe(true)
    expect(result.ok).toMatchObject({ kind: 'process_completion', session_id: 'sess-A', status: 'succeeded', exit_code: 0 })
    expect(result.ok.producer_key).toMatch(/^hermes-process:/)
    expect(result.ok.message).toContain('ok-output')
    expect(result.bad).toMatchObject({ status: 'failed', exit_code: 3 })
    expect(result.admitted).toEqual({ admitted: true })
    expect(result.completed).toEqual({ completed: true })
    expect(result.replayed).toBe(false)
  })

  it('emits nothing when notify_on_complete is false', async () => {
    const result = await runCase('process_notify_false')
    expect(result.result.notify_on_complete ?? false).toBe(false)
    expect(result.delivered).toBe(false)
  })

  it('reports live notify processes and still delivers an immediate exit', async () => {
    const result = await runCase('process_pending_and_immediate_exit')
    expect(result.pending).toEqual(['sess-A'])
    expect(result.immediate_delivered).toBe(true)
  })

  it('recovers the native immediate-exit race from the live record exactly once', async () => {
    const result = await runCase('process_immediate_exit_race')
    expect(result.native_event_published).toBe(false)
    expect(result.recovered).toBe(1)
    expect(result.duplicated).toBe(false)
    expect(result.message).toContain('exit code 0')
  })

  it('suppresses completions consumed by wait before drain and by log before dispatch', async () => {
    const result = await runCase('process_consumed_by_wait')
    expect(result.wait_before_drain_delivered).toBe(false)
    expect(result.claimed_after).toBe(true)
    expect(result.admit_after_log).toEqual({ admitted: false, reason: 'consumed' })
  })

  it('R2: a completion carries the owner generation declared when its process started', async () => {
    const result = await runCase('process_owner_generation')
    expect(result.owner_generation).toBe('gen-before-reset')
  })

  it('R10: settled notify processes stop keeping the poll active; live ones still do', async () => {
    const result = await runCase('settled_watchers')
    expect(result.settled_pending).toEqual([])
    expect(result.live_pending).toEqual(['sess-A'])
  })

  it('S3: a live process keeps its owner generation across more than 32 unchanged-owner turns; a reset still rejects', async () => {
    const result = await runCase('process_owner_generation_long_lived')
    expect(result.long_owner_generation).toBe('gen-long')
    expect(result.long_current).toBe('gen-long')
    // A true reset keeps the producer's original generation, which no longer matches the owner.
    expect(result.reset_owner_generation).toBe('gen-before')
    expect(result.reset_current).toBe('gen-after')
  })

  it('S5: an immediate exit keeps the real Studio poll gate open across the recovery grace, then lets it close', async () => {
    const result = await runCase('immediate_exit_poll_gate')
    const polls = result.polls as Array<{ pending: string[]; process_notifications: any[]; at: number }>
    expect(polls[0].process_notifications).toEqual([])
    expect(polls[0].at - result.exited_at).toBeLessThan(1)
    const delivered = polls.findIndex(poll => poll.process_notifications.some(item => item.process_id === result.process_id))
    expect(delivered).toBeGreaterThan(0)
    expect(polls.slice(delivered + 1).every(poll => poll.process_notifications.length === 0)).toBe(true)

    // Feed the real adapter results, shaped by the broker, through the production Studio poll gate.
    vi.resetModules()
    const chatRuntime = await import('../../packages/server/src/modules/studio/public/chat-agent-runtime')
    vi.spyOn(chatRuntime, 'createPrimaryAgentBridge').mockReturnValue({} as any)
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const nsp: any = { use: vi.fn(), on: vi.fn(), to: vi.fn(() => ({ emit: vi.fn() })), adapter: { rooms: new Map() }, sockets: new Map() }
    const server: any = new ChatRunSocket({ of: () => nsp } as any)
    clearInterval(server.backgroundPollTimer)
    clearInterval(server.cronObserveTimer)
    server.backgroundRecoveryNeeded = false
    server.backgroundActivityGraceUntil = 0
    server.sessionMap.set('sess-A', { messages: [], isWorking: false, events: [], queue: [], processNotifyPending: true })
    const scheduled: any[] = []
    vi.spyOn(server, 'scheduleProcessNotification').mockImplementation(async (item: any) => { scheduled.push(item) })
    const broker = (poll: (typeof polls)[number]) => ({ broker_id: 'b', pending_count: 0, sessions: [], notifications: [],
      process_notifications: poll.process_notifications.map(item => ({ ...item, profile: 'default' })),
      notify_pending: (poll.pending || []).map(sessionId => ({ profile: 'default', session_id: sessionId })) })
    const gate: boolean[] = []
    for (const poll of polls) {
      server.backgroundBridge = { backgroundPoll: vi.fn(async () => broker(poll)) }
      server.backgroundPollRetryAt = 0
      await server.pollBackgroundWork()
      gate.push(server.needsBackgroundPoll())
    }
    // Open on every poll before the recovered completion arrives; closed once it has been delivered.
    expect(gate.slice(0, delivered)).toEqual(Array(delivered).fill(true))
    expect(gate[gate.length - 1]).toBe(false)
    expect(scheduled.map(item => item.process_id)).toEqual([result.process_id])
  })

  it('S5 controls: a consumed or notify-off immediate exit is not pending and never republished', async () => {
    const result = await runCase('immediate_exit_pending_controls')
    expect(result.consumed_pending).toEqual([])
    expect(result.quiet_pending).toEqual([])
    expect(result.later_pending).toEqual([])
    expect(result.later_notifications).toEqual([])
  })

  it('routes completions only to the owning session', async () => {
    const result = await runCase('process_ownership')
    expect(result.a_received).toBe(false)
    expect(result.b_received).toBe(true)
    expect(result.b_session).toBe('sess-B')
  })
})
