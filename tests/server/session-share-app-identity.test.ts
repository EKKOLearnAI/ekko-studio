import { describe, expect, it, vi } from 'vitest'
import { ShareAppIdentityVerifier } from '../../packages/server/src/modules/studio/services/session-shares/app-identity'

const account = () => Response.json({ ok: true, user: { id: 123, displayName: 'Verified name', email: 'private@example.test' } })

describe('share App account verification', () => {
  it('uses the configured cloud account endpoint and keeps only a short-lived verified identity', async () => {
    let now = Date.now()
    const fetcher = vi.fn(async () => account())
    const verifier = new ShareAppIdentityVerifier(async () => 'https://cloud.example.test', fetcher as any, () => now)
    expect(await verifier.verify('app-access')).toEqual({ id: 123, name: 'Verified name', validUntil: now + 10_000 })
    expect(fetcher.mock.calls[0][0].toString()).toBe('https://cloud.example.test/api/app/auth/me')
    expect(fetcher.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer app-access' }, redirect: 'error' })
    const actor = await verifier.verify('app-access')
    actor.id = 999
    expect((await verifier.verify('app-access')).id).toBe(123)
    expect(fetcher).toHaveBeenCalledTimes(1)
    now += 10_001
    await verifier.verify('app-access')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('does not share identities between tokens or configured cloud origins', async () => {
    let origin = 'https://one.example.test'
    const fetcher = vi.fn(async () => account())
    const verifier = new ShareAppIdentityVerifier(async () => origin, fetcher as any)
    await verifier.verify('a'); await verifier.verify('b')
    origin = 'https://two.example.test'
    await verifier.verify('a')
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('does not extend identity cache past the already-verified access token expiry', async () => {
    let now = 1_000_000
    const token = `header.${Buffer.from(JSON.stringify({ exp: 1002 })).toString('base64url')}.signature`
    const fetcher = vi.fn(async () => account())
    const verifier = new ShareAppIdentityVerifier(async () => 'https://cloud.example.test', fetcher as any, () => now)
    expect((await verifier.verify(token)).validUntil).toBe(1_002_000)
    now = 1_002_000
    await expect(verifier.verify(token)).rejects.toThrow('share_app_login_required')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it.each([401, 403, 404])('rejects revoked/inactive cloud accounts (%s)', async status => {
    const verifier = new ShareAppIdentityVerifier(async () => 'https://cloud.example.test', vi.fn(async () => new Response('', { status })) as any)
    await expect(verifier.verify('access')).rejects.toThrow('share_app_login_required')
  })

  it('fails closed on cloud outages or invalid responses instead of trusting a claimed user ID', async () => {
    const fetcher = vi.fn(async () => { throw new Error('network') })
    const verifier = new ShareAppIdentityVerifier(async () => 'https://cloud.example.test', fetcher as any)
    await expect(verifier.verify('access')).rejects.toThrow('share_identity_unavailable')
    for (const value of [{ ok: true, user: { id: '123', displayName: 'spoof' } }, { ok: false }, { ok: true, user: { id: 123 } }]) {
      const invalid = new ShareAppIdentityVerifier(async () => 'https://cloud.example.test', vi.fn(async () => Response.json(value)) as any)
      await expect(invalid.verify('access')).rejects.toThrow('share_identity_unavailable')
    }
  })

  it('rejects empty, oversized and header-injection credentials before network IO', async () => {
    const fetcher = vi.fn(async () => account())
    const verifier = new ShareAppIdentityVerifier(async () => 'https://cloud.example.test', fetcher as any)
    for (const token of ['', 'a\r\nb', 'x'.repeat(16_385)]) {
      await expect(verifier.verify(token)).rejects.toThrow('share_app_login_required')
    }
    expect(fetcher).not.toHaveBeenCalled()
  })
})
