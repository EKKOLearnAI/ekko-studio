import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDecipheriv } from 'node:crypto'

describe('run push provenance and registration', () => {
  let db: any, home: string
  const inspect = vi.fn()
  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    home = mkdtempSync(join(tmpdir(), 'push-test-'))
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({ getDb: () => db }))
    vi.doMock('../../packages/server/src/modules/studio/public/config', () => ({ config: { appHome: home } }))
    vi.doMock('../../packages/server/src/modules/studio/public/auth', () => ({ inspectAppUserToken: inspect }))
    vi.doMock('../../packages/server/src/modules/studio/public/system-info', () => ({ getAppRelayDeviceIdentity: async () => ({ device_id: 'studio-a' }) }))
    inspect.mockReset()
  })
  afterEach(() => {
    db.close(); rmSync(home, { recursive: true, force: true })
    for (const path of ['infrastructure/database/index', 'public/config', 'public/auth', 'public/system-info'])
      vi.doUnmock(`../../packages/server/src/modules/studio/${path}`)
    vi.resetModules()
  })
  const actor = { userId: 7, deviceId: 'phone-a', studioDeviceId: 'studio-a' }
  const body = { schema_version: 1, platform: 'ios', studio_device_id: 'studio-a', installation_ref: 'phone-a', cloud_user_id: 12, grant_id: 'grant-a', push_token: 'push_' + 'a'.repeat(43), app_id: 'com.ekkostudio.ai', apns_environment: 'development', apns_token: 'ab'.repeat(32) }
  it('derives identity only from an active device credential', async () => {
    const { authenticatedPushActor } = await import('../../packages/server/src/modules/studio/services/notifications/push-registration')
    inspect.mockResolvedValue(null)
    expect(await authenticatedPushActor('web')).toBeNull()
    inspect.mockResolvedValue({ status: 'active', user: { id: 7 }, deviceCode: 'phone-a' })
    expect(await authenticatedPushActor('app')).toEqual(actor)
    inspect.mockResolvedValue({ status: 'revoked', user: { id: 7 }, deviceCode: 'phone-a' })
    await expect(authenticatedPushActor('app')).rejects.toThrow('authentication_failed')
  })
  it('stores one encrypted snapshot per run with its authoritative Studio device ID', async () => {
    const { prepareRunPushSnapshot } = await import('../../packages/server/src/modules/studio/services/notifications/push-registration')
    const store = await import('../../packages/server/src/modules/studio/repositories/run-push-store')
    const ref = { kind: 'chat' as const, profile: 'default', runId: 'run-a' }
    const ciphertext = prepareRunPushSnapshot(actor, { ...body, app_token: 'never-store', expires_at: 1 })!
    const run = store.bindRunPushTarget(ref, 'session-a', actor, { ciphertext, platform: 'ios' })
    expect(run.studio_device_id).toBe('studio-a')
    expect(run.device_id).toBe('phone-a')
    expect(JSON.stringify(run)).not.toContain(body.apns_token)
    expect(JSON.stringify(run)).not.toContain(body.push_token)
    const [, iv, tag, encrypted] = ciphertext.split('.')
    const decipher = createDecipheriv('aes-256-gcm', readFileSync(join(home, '.push-token-key')), Buffer.from(iv, 'base64'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    const saved = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString())
    expect(saved).toMatchObject(body)
    expect(saved.app_token).toBeUndefined()
    expect(saved.expires_at).toBeUndefined()
    const replacement = prepareRunPushSnapshot(actor, { ...body, push_token: 'push_' + 'b'.repeat(43) })
    expect(store.bindRunPushTarget(ref, 'session-a', actor, { ciphertext: replacement, platform: 'ios' }).push_snapshot_ciphertext).toBe(ciphertext)
    const { readRunPushNotification } = await import('../../packages/server/src/modules/studio/services/notifications/run-push-snapshot')
    expect(readRunPushNotification(ref)).toMatchObject({ credential: body.push_token,
      route: { studio_device_id: 'studio-a', session_id: 'session-a', run_id: 'run-a' } })
    expect(JSON.stringify(readRunPushNotification(ref)!.route)).not.toContain(body.push_token)
    expect(() => store.bindRunPushTarget(ref, 'session-a', { ...actor, studioDeviceId: 'studio-b' })).toThrow('conflict')
  })
  it('keeps each root owned by its initiating phone, with child IDs inheriting that target', async () => {
    const s = await import('../../packages/server/src/modules/studio/repositories/run-push-store')
    for (const kind of ['chat', 'group', 'workflow'] as const) {
      const ref = { kind, profile: 'default', runId: kind + '-root' }
      const a = s.bindRunPushTarget(ref, 'subject', actor)
      expect(s.bindRunPushTarget(ref, 'subject', actor).id).toBe(a.id)
      expect(() => s.bindRunPushTarget(ref, 'subject', { ...actor, deviceId: 'phone-b' })).toThrow('conflict')
      s.linkPushRun(kind, 'room', 'child', a)
      expect(s.findPushRunLink(kind, 'room', 'child')!.id).toBe(a.id)
      const b = s.bindRunPushTarget({ ...ref, runId: 'other' }, 'subject', { ...actor, deviceId: 'phone-b' })
      expect(() => s.linkPushRun(kind, 'room', 'child', b)).toThrow('conflict')
    }
  })
  it('rolls back provenance together with failed run/message persistence, including nested savepoints', async () => {
    const s = await import('../../packages/server/src/modules/studio/repositories/run-push-store')
    expect(() => s.pushRunTransaction(() => {
      s.bindRunPushTarget({ kind: 'group', profile: 'default', runId: 'failed' }, 'room', actor)
      db.exec('SAVEPOINT group_message_save'); db.exec('RELEASE group_message_save')
      throw new Error('persistence failed')
    })).toThrow('persistence failed')
    expect(s.getRunPushTarget({ kind: 'group', profile: 'default', runId: 'failed' })).toBeNull()
  })
  it('ignores malformed/foreign push metadata without blocking the run or making network requests', async () => {
    const { prepareRunPushSnapshot } = await import('../../packages/server/src/modules/studio/services/notifications/push-registration')
    expect(prepareRunPushSnapshot(actor, { ...body, apns_token: 'not-an-address' })).toBeNull()
    expect(prepareRunPushSnapshot(actor, { ...body, studio_device_id: 'studio-b' })).toBeNull()
    expect(prepareRunPushSnapshot(actor, { ...body, installation_ref: 'phone-b' })).toBeNull()
    expect(prepareRunPushSnapshot(actor, { ...body, push_token: 'app-login-token' })).toBeNull()
    expect(prepareRunPushSnapshot(actor, null)).toBeNull()
    expect(prepareRunPushSnapshot(actor, { ...body, platform: 'android', apns_token: '' })).toBeTruthy()
  })
})
