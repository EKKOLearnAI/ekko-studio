import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { BusinessEvent } from '../../packages/server/src/modules/studio/services/webhooks/business-events'

describe('user device APNs delivery', () => {
  let db: any, home: string, connections: any[], users: Map<number, any>, session: any, workflow: any
  const fetchMock = vi.fn(), inspect = vi.fn()
  let appRelayRoute: 'official' | 'cloudflare' | undefined
  const paths = ['infrastructure/database/index', 'public/config', 'public/auth', 'public/system-info',
    'repositories/app-connections-store', 'repositories/users-store', 'repositories/session-store',
    'repositories/workflow-run-store', 'services/webhooks/app-event-state', 'services/config/app-config']
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:'); home = mkdtempSync(join(tmpdir(), 'user-push-'))
    connections = []; users = new Map(); workflow = null
    appRelayRoute = undefined
    vi.stubEnv('STUDIO_PUSH_CONTENT_PREVIEW', '0')
    session = { title: 'Saved task', profile: 'default', user_id: 7 }
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({ getDb: () => db }))
    vi.doMock('../../packages/server/src/modules/studio/public/config', () => ({ config: { appHome: home, appRelay: { url: 'https://push.test' } } }))
    vi.doMock('../../packages/server/src/modules/studio/services/config/app-config', () => ({ readAppConfig: async () => ({ appRelayRoute }) }))
    vi.doMock('../../packages/server/src/modules/studio/public/auth', () => ({ inspectAppUserToken: inspect }))
    vi.doMock('../../packages/server/src/modules/studio/public/system-info', () => ({ getAppRelayDeviceIdentity: async () => ({ device_id: 'studio-a' }) }))
    vi.doMock('../../packages/server/src/modules/studio/repositories/app-connections-store', () => ({ listAppConnections: () => connections, hashAppCredential: hash }))
    vi.doMock('../../packages/server/src/modules/studio/repositories/users-store', () => ({ findUserById: (id: number) => users.get(id), listUserProfiles: () => [{ profile_name: 'default' }] }))
    vi.doMock('../../packages/server/src/modules/studio/repositories/session-store', () => ({ getSession: () => session, getSessionNotificationPreview: () => session,
      getSessionContextMessage: (_sessionId: string, messageId: number) => messageId === 42 ? { id: 42, role: 'assistant', content: 'Persisted current reply', display_content: null } : null }))
    vi.doMock('../../packages/server/src/modules/studio/repositories/workflow-run-store', () => ({ getWorkflowRun: () => workflow, getWorkflowRunForSession: () => workflow }))
    vi.doMock('../../packages/server/src/modules/studio/services/webhooks/app-event-state', () => ({ appEventState: () => [] }))
    inspect.mockReset().mockImplementation(async (token: string) => {
      const c = connections.find(row => row.token_hash === hash(token))
      return c ? { status: c.revoked_at ? 'revoked' : 'active', user: users.get(c.user_id), deviceCode: c.device_code, connectionType: 'cloud' } : null
    })
    fetchMock.mockReset().mockResolvedValue({ status: 200, body: { cancel: vi.fn() } })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    db.close(); rmSync(home, { recursive: true, force: true })
    paths.forEach(path => vi.doUnmock(`../../packages/server/src/modules/studio/${path}`)); vi.resetModules()
  })
  function event(patch: Partial<BusinessEvent> = {}): BusinessEvent {
    return { schema_version: 1, id: 'event-a', type: 'chat.run.completed', occurred_at: '2026-09-18T12:00:00Z',
      profile: 'default', source: 'chat', subject: { session_id: 'session-a', run_id: 'runtime-a' },
      payload: { run_id: 'runtime-a', output: 'Done' }, ...patch }
  }
  async function register(userId = 7, deviceId = 'phone-a', tokenByte = 'ab') {
    const token = `login-${userId}-${deviceId}`
    users.set(userId, { id: userId, username: `user-${userId}`, role: 'admin', status: 'active' })
    const connection = { id: connections.length + 1, user_id: userId, device_code: deviceId, connection_type: 'cloud',
      cloud_user_id: userId + 100, token_hash: hash(token), token_expires_at: Date.now() / 1000 + 3600, revoked_at: null }
    connections.push(connection)
    const body = { schema_version: 1, platform: 'ios', studio_device_id: 'studio-a', installation_ref: deviceId,
      cloud_user_id: userId + 100, grant_id: 'grant-a', push_token: 'push_' + 'a'.repeat(43),
      app_id: 'com.ekkostudio.ai', apns_environment: 'production', apns_token: tokenByte.repeat(32) }
    const { updateUserPushRegistration } = await import('../../packages/server/src/modules/studio/services/notifications/user-push-registration')
    await updateUserPushRegistration(token, body)
    return { body, token, connection, update: updateUserPushRegistration }
  }
  async function consumer() {
    return (await import('../../packages/server/src/modules/studio/services/notifications/run-push')).createRunPushConsumer(fetchMock)
  }
  it('follows the current relay route on each event without recreating the consumer', async () => {
    await register()
    const consume = await consumer()
    await consume(event())
    appRelayRoute = 'cloudflare'
    await consume(event({ id: 'cloudflare-event' }))
    appRelayRoute = 'official'
    await consume(event({ id: 'official-event' }))
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://push.test/push/v1/send',
      'https://cn.ekkostudio.xyz/push/v1/send',
      'https://push.test/push/v1/send',
    ])
  })
  it('notifies all owner devices for desktop runs without snapshots and excludes another user', async () => {
    await register(); await register(7, 'phone-b', 'bc'); await register(8, 'phone-c', 'cd')
    const consume = await consumer(); await consume(event()); await consume(event())
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const bodies = fetchMock.mock.calls.map(([, request]) => JSON.parse(request.body))
    expect(bodies.map(body => body.recipient.apns_token)).toEqual(['ab'.repeat(32), 'bc'.repeat(32)])
    expect(bodies[0]).toMatchObject({ notification: { title: '', body: '' },
      ekko_run: { cloud_user_id: 107, run_kind: 'chat', session_id: 'session-a', run_id: 'runtime-a' } })
    expect(JSON.stringify(bodies)).not.toContain('push_')
  })
  it('never includes long private titles or generated output in push requests', async () => {
    await register()
    session.title = 'PRIVATE TITLE'.repeat(1000)
    const consume = await consumer()
    await consume(event({ payload: { run_id: 'runtime-a', output: 'PRIVATE REPLY😀'.repeat(10000) } }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = fetchMock.mock.calls[0][1].body
    expect(JSON.parse(body).notification).toEqual({ title: '', body: '' })
    expect(body).not.toContain('PRIVATE')
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThan(4096)
  })
  it('opt-in sends current final reply without historical preview fallback', async () => {
    vi.stubEnv('STUDIO_PUSH_CONTENT_PREVIEW', '1')
    await register()
    session.preview = 'OLD PRIVATE REPLY'
    const consume = await consumer()
    await consume(event({ payload: { run_id: 'runtime-a', output: '' } }))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).notification).toEqual({ title: 'Saved task', body: '' })
    await consume(event({ id: 'next', payload: { run_id: 'runtime-b', output: '**Done** ```hidden' } }))
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).notification).toEqual({ title: 'Saved task', body: 'Done' })
  })
  it('uses the exact persisted terminal message when the completion payload output is empty', async () => {
    vi.stubEnv('STUDIO_PUSH_CONTENT_PREVIEW', '1')
    await register()
    const consume = await consumer()
    await consume(event({ subject: { session_id: 'session-a', run_id: 'runtime-a', message_id: '42' }, payload: { run_id: 'runtime-a', output: '' } }))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).notification).toEqual({ title: 'Saved task', body: 'Persisted current reply' })
  })
  it('mutes APNs without deleting registration and token refresh does not re-enable the connection', async () => {
    const a = await register(); await register(7, 'phone-b', 'bc')
    a.connection.push_enabled = 0
    await a.update(a.token, { ...a.body, apns_token: 'de'.repeat(32) })
    const consume = await consumer(); await consume(event())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).recipient.apns_token).toBe('bc'.repeat(32))
    expect((await import('../../packages/server/src/modules/studio/repositories/user-push-store')).listUserPushDevices()).toHaveLength(2)
    a.connection.push_enabled = 1
    await consume(event({ id: 'enabled' })); expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('encrypts tokens at rest, replaces rotated tokens, and reassigns a phone to its new user', async () => {
    const a = await register(); const store = await import('../../packages/server/src/modules/studio/repositories/user-push-store')
    expect(JSON.stringify(store.listUserPushDevices())).not.toContain(a.body.apns_token)
    expect(JSON.stringify(store.listUserPushDevices())).not.toContain(a.body.push_token)
    await a.update(a.token, { ...a.body, apns_token: 'de'.repeat(32) })
    expect(store.listUserPushDevices()).toHaveLength(1)
    const consume = await consumer(); await consume(event())
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).recipient.apns_token).toBe('de'.repeat(32))
    await register(8, 'phone-a', 'de'); fetchMock.mockClear()
    expect(store.listUserPushDevices()).toHaveLength(1)
    await consume(event({ id: 'next' })); expect(fetchMock).not.toHaveBeenCalled()
    session.user_id = 8
    await consume(event({ id: 'next' })); expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('rejects forged identities, foreign installations, web credentials and revoked connections', async () => {
    const a = await register()
    await expect(a.update('web', a.body)).rejects.toThrow('authentication_failed')
    for (const patch of [{ installation_ref: 'other' }, { studio_device_id: 'other' }, { cloud_user_id: 999 }, { apns_token: 'bad' }, { platform: 'android' }]) {
      await expect(a.update(a.token, { ...a.body, ...patch })).rejects.toThrow('invalid_push_registration')
    }
    await a.update(a.token, { ...a.body, user_id: 8 })
    expect((await import('../../packages/server/src/modules/studio/repositories/user-push-store')).listUserPushDevices()[0].user_id).toBe(7)
    a.connection.revoked_at = 1
    await expect(a.update(a.token, a.body)).rejects.toThrow('authentication_failed')
    await (await consumer())(event()); expect(fetchMock).not.toHaveBeenCalled()
  })
  it('honors Profile removal, disabled users, ownerless sessions and expired or rotated login connections', async () => {
    const a = await register(), consume = await consumer()
    await consume(event({ profile: 'foreign' }))
    session.user_id = null; await consume(event()); session.user_id = 7
    users.get(7).status = 'disabled'; await consume(event()); users.get(7).status = 'active'
    a.connection.token_expires_at = 0; await consume(event())
    expect(fetchMock).not.toHaveBeenCalled()
    a.connection.token_expires_at = Date.now() / 1000 + 3600
    await a.update(a.token, a.body); a.connection.token_hash = 'rotated'
    await consume(event()); expect(fetchMock).not.toHaveBeenCalled()
  })
  it('unregisters only the authenticated connection and preserves other phones', async () => {
    const a = await register(); await register(7, 'phone-b', 'bc')
    await a.update(a.token, null, true)
    await (await consumer())(event()); expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).recipient.apns_token).toBe('bc'.repeat(32))
  })
  it('uses the shared group owner policy and the persisted workflow owner', async () => {
    await register(); await register(8, 'other', 'bc')
    const { registerGroupEventAccess } = await import('../../packages/server/src/modules/studio/services/webhooks/app-events')
    registerGroupEventAccess({ canReceive: user => user.id === 7 })
    const consume = await consumer()
    await consume(event({ type: 'group.message.created', source: 'group_chat', subject: { room_id: 'room-a', message_id: 'reply-a' },
      payload: { room: { id: 'room-a', name: 'Room' }, message: { id: 'reply-a', senderName: 'Agent', senderType: 'agent', role: 'assistant', content: 'Group reply' } } }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).ekko_run).toMatchObject({ run_kind: 'group', room_id: 'room-a', cloud_user_id: 107 })
    workflow = { id: 'workflow-run', workflow_id: 'workflow-a', user_id: 8, profile: 'default' }
    await consume(event({ type: 'workflow.run.completed', source: 'workflow', subject: { workflow_id: 'workflow-a', run_id: 'workflow-run' }, payload: { display: { title: 'Workflow' } } }))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).ekko_run.cloud_user_id).toBe(108)
  })
  it('ignores replay, child runs, queued terminals and resolved events without exposing errors or commands', async () => {
    await register(); const consume = await consumer()
    for (const patch of [{ source: 'workflow' }, { source: 'group_chat' }, { type: 'chat.approval.resolved' },
      { payload: { replayed: true } }, { payload: { interrupted: true } }, { payload: { run_id: 'runtime-a', queue_remaining: 1 } }]) await consume(event(patch))
    expect(fetchMock).not.toHaveBeenCalled()
    await consume(event({ type: 'chat.approval.requested', subject: { session_id: 'session-a', approval_id: 'approval-a' }, payload: { approval_id: 'approval-a', command: 'SECRET' } }))
    await consume(event({ type: 'chat.run.failed', payload: { run_id: 'runtime-a', error: 'SECRET' } }))
    expect(fetchMock).toHaveBeenCalledTimes(2); expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('SECRET')
  })
  it('isolates a failed phone and allows later turns with the same runtime ID', async () => {
    await register(); await register(7, 'phone-b', 'bc')
    fetchMock.mockRejectedValueOnce(new Error('network'))
    const consume = await consumer(); await expect(consume(event())).resolves.toBeUndefined()
    await consume(event()); expect(fetchMock).toHaveBeenCalledTimes(2)
    await consume(event({ occurred_at: '2026-09-18T12:01:00Z' })); expect(fetchMock).toHaveBeenCalledTimes(4)
  })
  it('removes invalid APNs addresses without deleting a registration refreshed during delivery', async () => {
    const a = await register(), consume = await consumer()
    fetchMock.mockImplementationOnce(async () => {
      await a.update(a.token, { ...a.body, apns_token: 'cd'.repeat(32) })
      return { status: 410, json: async () => ({ error: 'apns_recipient_unregistered' }) }
    })
    await consume(event())
    const store = await import('../../packages/server/src/modules/studio/repositories/user-push-store')
    expect(store.listUserPushDevices()).toHaveLength(1)
    fetchMock.mockResolvedValueOnce({ status: 422, json: async () => ({ error: 'apns_invalid_recipient' }) })
    await consume(event({ id: 'later' })); expect(store.listUserPushDevices()).toHaveLength(0)
  })
})
