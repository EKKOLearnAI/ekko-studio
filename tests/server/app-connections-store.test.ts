import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('App connections store', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.resetModules()
  })

  it('defaults legacy and new devices to enabled and preserves a toggle across token renewal', async () => {
    const store = await import('../../packages/server/src/modules/studio/repositories/app-connections-store')
    const input = { deviceCode: 'phone-push', deviceName: 'Phone', deviceBrand: '', deviceModel: '',
      connectionType: 'lan' as const, userId: 7, token: 'token-a', tokenExpiresAt: 5000, now: 1000 }
    const first = store.upsertAppConnection(input)
    expect(first.push_enabled).toBe(1)
    db.exec('ALTER TABLE app_connections DROP COLUMN push_enabled')
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
    expect(store.listAppConnections()[0].push_enabled).toBe(1)
    store.updateAppConnectionPushEnabled(first.id, false)
    expect(store.isAppConnectionPushEnabled('token-a')).toBe(false)
    const renewed = store.upsertAppConnection({ ...input, token: 'token-b' })
    expect(renewed.id).toBe(first.id); expect(renewed.push_enabled).toBe(0)
    expect(store.isAppConnectionPushEnabled('token-b')).toBe(false)
    expect(store.isAppConnectionPushEnabled('browser-jwt')).toBe(true)
    const other = store.upsertAppConnection({ ...input, deviceCode: 'other', token: 'other-token' })
    expect(other.push_enabled).toBe(1)
    expect(store.isAppConnectionPushEnabled('other-token')).toBe(true)
    store.updateAppConnectionPushEnabled(first.id, true)
    expect(store.isAppConnectionPushEnabled('token-b')).toBe(true)
    store.revokeAppConnection(first.id)
    expect(store.updateAppConnectionPushEnabled(first.id, true)).toBeNull()
  })

  it('stores only a hash of each five-minute authorization code and consumes it once', async () => {
    const store = await import('../../packages/server/src/modules/studio/repositories/app-connections-store')
    const issued = store.createAppAuthorizationCode(42, 1_000)
    const row = db.prepare('SELECT * FROM app_authorization_codes WHERE id = ?')
      .get(issued.record.id) as any

    expect(row.code_hash).toBe(store.hashAppCredential(issued.authorizationCode))
    expect(row.code_hash).not.toContain(issued.authorizationCode)
    expect(row.created_by_user_id).toBe(42)
    expect(row.expires_at).toBe(1_000 + 5 * 60)

    const consumed = store.consumeAppAuthorizationCode(issued.authorizationCode, 'phone-001', 1_100)
    expect(consumed.created_by_user_id).toBe(42)
    expect(consumed.used_by_device_code).toBe('phone-001')
    expect(() => store.consumeAppAuthorizationCode(issued.authorizationCode, 'phone-002', 1_101))
      .toThrow('app_authorization_code_used')
  })

  it('rejects expired authorization codes', async () => {
    const store = await import('../../packages/server/src/modules/studio/repositories/app-connections-store')
    const issued = store.createAppAuthorizationCode(7, 2_000)

    expect(() => store.consumeAppAuthorizationCode(issued.authorizationCode, 'phone-001', 2_301))
      .toThrow('app_authorization_code_expired')
  })

  it('migrates the legacy global device/type uniqueness to cloud-account uniqueness', async () => {
    db.exec('DROP INDEX uniq_app_connections_device_type_cloud_user')
    db.exec('DROP INDEX idx_app_connections_cloud_user')
    db.exec('ALTER TABLE app_connections DROP COLUMN cloud_user_id')
    db.exec('CREATE UNIQUE INDEX uniq_app_connections_device_type ON app_connections(device_code, connection_type)')
    db.prepare(`
      INSERT INTO app_connections (
        device_code, device_name, device_brand, device_model, connection_type, user_id,
        token_hash, token_expires_at, last_connected_at, revoked_at,
        cloud_revocation_pending, created_at, updated_at
      ) VALUES ('legacy-phone', 'Legacy Phone', '', '', 'cloud', 7, 'hash', 5000, 3000, NULL, 1, 3000, 3000)
    `).run()

    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()

    const columns = db.prepare('PRAGMA table_info(app_connections)').all() as Array<{ name: string }>
    const indexes = db.prepare('PRAGMA index_list(app_connections)').all() as Array<{ name: string }>
    expect(columns.map(column => column.name)).toContain('cloud_user_id')
    expect(indexes.map(index => index.name)).toContain('uniq_app_connections_device_type_cloud_user')
    expect(indexes.map(index => index.name)).not.toContain('uniq_app_connections_device_type')
    expect(db.prepare('SELECT cloud_user_id, cloud_revocation_pending FROM app_connections WHERE device_code = ?')
      .get('legacy-phone')).toMatchObject({ cloud_user_id: 0, cloud_revocation_pending: 0 })
  })

  it('deduplicates by phone, connection type, and cloud account while validating each token', async () => {
    const store = await import('../../packages/server/src/modules/studio/repositories/app-connections-store')
    const first = store.upsertAppConnection({
      deviceCode: 'phone-001',
      deviceName: 'Alice iPhone',
      deviceBrand: 'Apple',
      deviceModel: 'iPhone 16,1',
      connectionType: 'lan',
      userId: 7,
      token: 'first-token',
      tokenExpiresAt: 4_000,
      now: 3_000,
    })
    const updated = store.upsertAppConnection({
      deviceCode: 'phone-001',
      deviceName: 'Alice iPhone 16',
      deviceBrand: 'Apple',
      deviceModel: 'iPhone 17,1',
      connectionType: 'lan',
      userId: 7,
      token: 'second-token',
      tokenExpiresAt: 5_000,
      now: 3_100,
    })

    expect(updated.id).toBe(first.id)
    expect(store.listAppConnections()).toHaveLength(1)
    expect(updated).toMatchObject({
      device_name: 'Alice iPhone 16',
      device_brand: 'Apple',
      device_model: 'iPhone 17,1',
      connection_type: 'lan',
      user_id: 7,
    })
    expect(store.isAppConnectionTokenActive('phone-001', 'lan', 'first-token', 7, 3_200)).toBe(false)
    expect(store.isAppConnectionTokenActive('phone-001', 'lan', 'second-token', 7, 3_200)).toBe(true)
    expect(store.isAppConnectionTokenActive('phone-001', 'lan', 'second-token', 8, 3_200)).toBe(false)
    expect(store.isAppConnectionTokenActive('phone-001', 'lan', 'second-token', 7, 5_000)).toBe(false)

    const cloud = store.upsertAppConnection({
      deviceCode: 'phone-001',
      deviceName: 'Alice iPhone 16',
      deviceBrand: 'Apple',
      deviceModel: 'iPhone 17,1',
      connectionType: 'cloud',
      userId: 7,
      cloudUserId: 101,
      token: 'cloud-token',
      tokenExpiresAt: 5_000,
      now: 3_200,
    })
    expect(cloud.id).not.toBe(updated.id)
    expect(store.listAppConnections()).toHaveLength(2)
    expect(store.isAppConnectionTokenActive('phone-001', 'cloud', 'cloud-token', 7, 3_300)).toBe(true)
    expect(store.isAppConnectionTokenActive('phone-001', 'lan', 'cloud-token', 7, 3_300)).toBe(false)

    const secondCloudAccount = store.upsertAppConnection({
      deviceCode: 'phone-001',
      deviceName: 'Alice iPhone 16',
      deviceBrand: 'Apple',
      deviceModel: 'iPhone 17,1',
      connectionType: 'cloud',
      userId: 7,
      cloudUserId: 202,
      token: 'second-cloud-token',
      tokenExpiresAt: 5_000,
      now: 3_300,
    })
    expect(secondCloudAccount.id).not.toBe(cloud.id)
    expect(store.listAppConnections()).toHaveLength(3)
    expect(store.isAppConnectionTokenActive('phone-001', 'cloud', 'cloud-token', 7, 3_400)).toBe(true)
    expect(store.isAppConnectionTokenActive('phone-001', 'cloud', 'second-cloud-token', 7, 3_400)).toBe(true)
  })

  it('hides revoked connections while retaining the tombstone for an offline App reconnect', async () => {
    const store = await import('../../packages/server/src/modules/studio/repositories/app-connections-store')
    const connection = store.upsertAppConnection({
      deviceCode: 'phone-offline',
      deviceName: 'Offline Phone',
      deviceBrand: 'Apple',
      deviceModel: 'iPhone 17,1',
      connectionType: 'lan',
      userId: 7,
      token: 'offline-token',
      tokenExpiresAt: 5_000,
      now: 3_000,
    })

    expect(store.getAppConnectionTokenStatus('phone-offline', 'lan', 'offline-token', 7, 3_100)).toBe('active')
    expect(store.revokeAppConnection(connection.id, 3_200)).toMatchObject({
      id: connection.id,
      revoked_at: 3_200,
    })
    expect(store.listAppConnections()).toEqual([])
    expect(store.getAppConnectionTokenStatus('phone-offline', 'lan', 'offline-token', 7, 3_300)).toBe('revoked')
    expect(store.isAppConnectionTokenActive('phone-offline', 'lan', 'offline-token', 7, 3_300)).toBe(false)
    expect(store.revokeAppConnection(connection.id, 3_400)).toBeNull()
  })

  it('queues an exact cloud-account revoke but never guesses an account for a legacy row', async () => {
    const store = await import('../../packages/server/src/modules/studio/repositories/app-connections-store')
    const exact = store.upsertAppConnection({
      deviceCode: 'shared-phone',
      deviceName: 'Shared Phone',
      deviceBrand: 'Google',
      deviceModel: 'Pixel',
      connectionType: 'cloud',
      userId: 7,
      cloudUserId: 101,
      token: 'exact-token',
      tokenExpiresAt: 5_000,
      now: 3_000,
    })
    const legacy = store.upsertAppConnection({
      deviceCode: 'legacy-phone',
      deviceName: 'Legacy Phone',
      deviceBrand: 'Google',
      deviceModel: 'Pixel',
      connectionType: 'cloud',
      userId: 7,
      token: 'legacy-token',
      tokenExpiresAt: 5_000,
      now: 3_000,
    })

    expect(store.revokeAppConnection(exact.id, 3_100)).toMatchObject({ cloud_revocation_pending: 1 })
    expect(store.revokeAppConnection(legacy.id, 3_100)).toMatchObject({ cloud_revocation_pending: 0 })
    expect(store.listPendingCloudAppConnectionRevocations()).toEqual([
      expect.objectContaining({ id: exact.id, cloud_user_id: 101 }),
    ])
  })

  it('assigns a legacy row only when the relay provides one exact cloud account', async () => {
    const store = await import('../../packages/server/src/modules/studio/repositories/app-connections-store')
    const legacy = store.upsertAppConnection({
      deviceCode: 'legacy-phone',
      deviceName: 'Legacy Phone',
      deviceBrand: 'Google',
      deviceModel: 'Pixel',
      connectionType: 'cloud',
      userId: 7,
      token: 'legacy-token',
      tokenExpiresAt: 5_000,
      now: 3_000,
    })

    expect(store.assignLegacyCloudAppConnectionUser('legacy-phone', 101)).toBe(true)
    expect(store.listAppConnections()).toEqual([
      expect.objectContaining({ id: legacy.id, cloud_user_id: 101 }),
    ])
    expect(store.assignLegacyCloudAppConnectionUser('legacy-phone', 202)).toBe(false)
  })
})
