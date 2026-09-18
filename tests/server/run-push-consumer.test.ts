import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BusinessEvent } from '../../packages/server/src/modules/studio/services/webhooks/business-events'

describe('run snapshot push consumer', () => {
  let db: any, home: string
  const fetchMock = vi.fn(), enqueue = vi.fn(), social = vi.fn(), info = vi.fn(), warn = vi.fn()
  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    home = mkdtempSync(join(tmpdir(), 'run-push-consumer-'))
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({ getDb: () => db }))
    vi.doMock('../../packages/server/src/modules/studio/public/config', () => ({ config: { appHome: home, appRelay: { url: 'https://push.test' } } }))
    vi.doMock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: { info, warn } }))
    vi.doMock('../../packages/server/src/modules/studio/repositories/session-store', () => ({ getSession: () => ({ title: 'Saved task' }) }))
    vi.doMock('../../packages/server/src/modules/studio/public/auth', () => ({ inspectAppUserToken: vi.fn() }))
    vi.doMock('../../packages/server/src/modules/studio/public/system-info', () => ({ getAppRelayDeviceIdentity: vi.fn() }))
    vi.doMock('../../packages/server/src/modules/studio/services/webhooks/dispatcher', () => ({ getChatWebhookDispatcher: () => ({ enqueue }) }))
    vi.doMock('../../packages/server/src/modules/studio/public/social-messages', () => ({ notifySessionPush: social }))
    fetchMock.mockReset().mockResolvedValue({ status: 200, json: vi.fn().mockResolvedValue({ accepted: true, apns_id: 'apns-a' }) })
    enqueue.mockReset(); social.mockReset(); info.mockReset(); warn.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    db.close(); rmSync(home, { recursive: true, force: true }); vi.unstubAllGlobals()
    for (const path of ['infrastructure/database/index', 'public/config', 'public/logging', 'repositories/session-store', 'public/auth', 'public/system-info', 'services/webhooks/dispatcher', 'public/social-messages']) {
      vi.doUnmock(`../../packages/server/src/modules/studio/${path}`)
    }
    vi.resetModules()
  })
  async function fixture(kind: 'chat' | 'group' | 'workflow' = 'chat', runId = 'root-a', platform = 'ios') {
    const s = await import('../../packages/server/src/modules/studio/repositories/run-push-store')
    const { prepareRunPushSnapshot } = await import('../../packages/server/src/modules/studio/services/notifications/push-registration')
    const actor = { userId: 7, deviceId: 'phone-a', studioDeviceId: 'studio-a' }
    const snapshot = { schema_version: 1, studio_device_id: 'studio-a', installation_ref: 'phone-a', cloud_user_id: 12,
      grant_id: 'grant-a', push_token: 'push_' + 'a'.repeat(43), platform, app_id: 'com.ekkostudio.ai',
      apns_environment: platform === 'ios' ? 'development' : '', apns_token: platform === 'ios' ? 'ab'.repeat(32) : '' }
    const target = s.bindRunPushTarget({ kind, profile: 'default', runId }, 'subject-a', actor,
      { ciphertext: prepareRunPushSnapshot(actor, snapshot), platform })
    const event: BusinessEvent = { schema_version: 1, id: 'event-a', type: 'chat.run.completed', occurred_at: new Date().toISOString(),
      profile: 'default', source: 'chat', push_target_id: target.id, subject: { session_id: 'subject-a', run_id: 'runtime-a' }, payload: { output: 'Done' } }
    const { createRunPushConsumer } = await import('../../packages/server/src/modules/studio/services/notifications/run-push')
    return { s, target, snapshot, event, consume: createRunPushConsumer(fetchMock, { retryDelaysMs: [1, 1], wait: vi.fn() }) }
  }
  it('uses only the saved token and Studio route, without retrying permanent gateway errors', async () => {
    const { event, consume, snapshot } = await fixture()
    fetchMock.mockResolvedValue({ status: 401, json: vi.fn().mockResolvedValue({ ok: false }) })
    await consume(event)
    await consume({ ...event, id: 'duplicate', subject: { ...event.subject, run_id: 'other-runtime-id' } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, request] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('https://push.test/push/v1/send')
    expect(request.headers.Authorization).toBe(`Bearer ${snapshot.push_token}`)
    expect(request.redirect).toBe('error')
    expect(request.signal).toBeInstanceOf(AbortSignal)
    const body = JSON.parse(request.body)
    expect(body).toMatchObject({ event_type: 'completion', recipient: { apns_token: snapshot.apns_token },
      ekko_run: { studio_device_id: 'studio-a', run_id: 'root-a', session_id: 'subject-a' }, notification: { title: 'Saved task', body: 'Done' } })
    expect(JSON.stringify(body.ekko_run)).not.toContain(snapshot.push_token)
    expect(JSON.stringify(body)).not.toContain(snapshot.push_token)
  })
  it('retries network failures and preserves separate roots even when runtime IDs repeat', async () => {
    const a = await fixture(), b = await fixture('chat', 'root-b')
    fetchMock.mockRejectedValueOnce(new TypeError('timeout, token should not be logged'))
      .mockResolvedValue({ status: 200, json: vi.fn().mockResolvedValue({ accepted: true }) })
    await expect(a.consume(a.event)).resolves.toBeUndefined()
    await a.consume(a.event)
    await a.consume(b.event)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ errorKind: 'network', retry: true }),
      '[run-push] notification request failed')
    expect(JSON.stringify(warn.mock.calls)).not.toContain(a.snapshot.push_token)
    expect(JSON.stringify(warn.mock.calls)).not.toContain(a.snapshot.apns_token)
  })
  it.each([429, 503])('retries HTTP %i and records only safe provider fields', async status => {
    const { event, consume, snapshot } = await fixture()
    fetchMock.mockResolvedValueOnce({ status, json: vi.fn().mockResolvedValue({ error: snapshot.push_token }) })
      .mockResolvedValue({ status: 200, json: vi.fn().mockResolvedValue({ accepted: true, apns_id: 'apns-ok' }) })
    await consume(event)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ status, retry: true }),
      '[run-push] notification rejected')
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ status: 200, accepted: true, apnsId: 'apns-ok', attempt: 2 }),
      '[run-push] notification accepted')
    expect(JSON.stringify([warn.mock.calls, info.mock.calls])).not.toContain(snapshot.push_token)
    expect(JSON.stringify([warn.mock.calls, info.mock.calls])).not.toContain(snapshot.apns_token)
  })
  it('allows a later delivery after all transient retries are exhausted', async () => {
    const { event, consume } = await fixture()
    fetchMock.mockResolvedValue({ status: 503, json: vi.fn().mockResolvedValue({ ok: false }) })
    await consume(event)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    fetchMock.mockResolvedValue({ status: 200, json: vi.fn().mockResolvedValue({ accepted: true }) })
    await consume({ ...event, id: 'replayed-by-event-bus' })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
  it('skips unbound, Android, replayed, interrupted and child terminal events', async () => {
    const { event, consume } = await fixture()
    const android = await fixture('chat', 'android', 'android')
    for (const patch of [ { push_target_id: undefined }, { source: 'workflow' }, { source: 'group_chat' },
      { profile: 'other' }, { payload: { replayed: true } }, { payload: { restored: true } },
      { payload: { interrupted: true } }, { payload: { stop_reason: 'aborted' } }, { type: 'chat.tool.failed' }, { type: 'chat.approval.resolved' },
      { type: 'chat.plan.updated' }, { type: 'group.plan.updated' }, { type: 'workflow.plan.updated' } ]) {
      await consume({ ...event, ...patch })
    }
    await consume(android.event)
    expect(fetchMock).not.toHaveBeenCalled()
    // Other queued roots must not suppress this root's actual completion.
    await consume({ ...event, payload: { queue_remaining: 1, output: 'First root complete' } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('sends each distinct interaction and terminal once without exposing commands or errors', async () => {
    const { event, consume } = await fixture()
    for (const [type, subject] of [ ['chat.approval.requested', { approval_id: 'approval-a' }],
      ['chat.clarification.requested', { clarification_id: 'clarify-a' }], ['chat.run.failed', {}] ] as const) {
      const next = { ...event, type, subject: { ...event.subject, ...subject }, payload: { command: 'SECRET', error: 'SECRET' } }
      await consume(next); await consume(next)
    }
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls.map(([, r]) => JSON.parse(r.body).event_type)).toEqual(['approval', 'interaction', 'failure'])
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('SECRET')
  })
  it('consumes group persisted failures/interactions and workflow terminals without a preceding chat event', async () => {
    const group = await fixture('group')
    group.s.linkPushRun('group_message', 'subject-a', 'error-message', group.target)
    group.s.linkPushRun('group_runtime', 'subject-a', 'runtime-g', group.target)
    const { publishGroupMessage, publishGroupInteraction, publishDomainEvent } = await import('../../packages/server/src/modules/studio/services/webhooks/domain-events')
    const room = { id: 'subject-a', name: 'Room', summaryProfile: 'default' }
    publishGroupInteraction(room, 'group.approval.requested', 'runtime-g', 'approval-g')
    publishGroupInteraction(room, 'group.clarification.requested', 'runtime-g', 'clarify-g')
    publishGroupMessage(room, { id: 'error-message', run_id: 'runtime-g', senderType: 'agent', role: 'assistant', content: 'SECRET raw error', finish_reason: 'error' }, [])
    await fixture('workflow', 'workflow-root')
    publishDomainEvent('workflow.run.completed', 'default', { workflow_id: 'subject-a', run_id: 'workflow-root' }, { title: 'Workflow' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))
    expect(fetchMock.mock.calls.map(([, r]) => JSON.parse(r.body).event_type)).toEqual(['approval', 'interaction', 'failure', 'completion'])
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('SECRET')
    expect(enqueue.mock.calls.map(([e]) => e.type)).toEqual(['group.approval.requested', 'group.clarification.requested', 'group.message.created', 'group.run.failed', 'workflow.run.completed'])
    expect(social).not.toHaveBeenCalled()
    const { buildChatWebhookEnvelope } = await import('../../packages/server/src/modules/studio/services/webhooks/envelope')
    for (const [event] of enqueue.mock.calls) {
      const envelope = buildChatWebhookEnvelope(event, false)
      expect(JSON.stringify(envelope)).not.toMatch(/SECRET|push_target_id|push_token|apns_token/)
    }
  })
})
