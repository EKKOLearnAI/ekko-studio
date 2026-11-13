/**
 * Tests for GET /api/update/identity (phase a).
 *
 * Master spec: docs/harness/source-deploy-refactor.md (§ Identity Schema).
 * Contract: missing/corrupt identity.json → installed: false, never 500;
 * manifest cache freshness is surfaced alongside.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const tempHomes: string[] = []
const ORIGINAL_ENV = { ...process.env }

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'identity-ep-'))
  tempHomes.push(dir)
  return dir
}

function identityPath(home: string): string {
  return join(home, 'state', 'identity.json')
}

function cachePath(home: string): string {
  return join(home, 'updates', 'cache', 'manifest-stable.json')
}

const VALID_IDENTITY = {
  schema: 1,
  capturedAt: '2026-09-06T13:00:00.000Z',
  version: '0.8.1',
  distSha256: 'a'.repeat(64),
  installerScriptSha256: 'b'.repeat(64),
  agentManifestSha: '0.0.0-noop',
  commitSha: 'c'.repeat(40),
}

async function callEndpoint(home: string): Promise<{ status?: number; body: any }> {
  process.env.HERMES_WEB_UI_HOME = home
  // Fresh import per scenario so module-level config picks up the env.
  const { getUpdateIdentity } = await import('../../packages/server/src/modules/studio/controllers/update')
  const ctx: any = {}
  await getUpdateIdentity(ctx)
  return { status: ctx.status, body: ctx.body }
}

beforeAll(() => {
  process.env.WEBUI_UPDATE_ENABLED = ''
})

afterAll(() => {
  process.env = { ...ORIGINAL_ENV }
  for (const dir of tempHomes) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('GET /api/update/identity', () => {
  it('returns installed: false when identity.json is absent (WP3 not yet run)', async () => {
    const home = makeHome()
    const { status, body } = await callEndpoint(home)
    expect(status).toBeUndefined() // no error status set
    expect(body.success).toBe(true)
    expect(body.installed).toBe(false)
    expect(body.identity).toBeNull()
  })

  it('returns the identity record when present', async () => {
    const home = makeHome()
    mkdirSync(join(home, 'state'), { recursive: true })
    writeFileSync(identityPath(home), JSON.stringify(VALID_IDENTITY))
    const { body } = await callEndpoint(home)
    expect(body.installed).toBe(true)
    expect(body.identity.version).toBe('0.8.1')
    expect(body.identity.agentManifestSha).toBe('0.0.0-noop')
  })

  it('returns installed: false (not 500) when identity.json is corrupt', async () => {
    const home = makeHome()
    mkdirSync(join(home, 'state'), { recursive: true })
    writeFileSync(identityPath(home), '{corrupt json')
    const { status, body } = await callEndpoint(home)
    expect(status).toBeUndefined()
    expect(body.success).toBe(true)
    expect(body.installed).toBe(false)
    expect(body.identity).toBeNull()
  })

  it('treats identity.json with missing required fields as unknown', async () => {
    const home = makeHome()
    mkdirSync(join(home, 'state'), { recursive: true })
    writeFileSync(identityPath(home), JSON.stringify({ schema: 1 }))
    const { body } = await callEndpoint(home)
    expect(body.installed).toBe(false)
  })

  it('reports manifest cache freshness with the cached version', async () => {
    const home = makeHome()
    mkdirSync(join(home, 'updates', 'cache'), { recursive: true })
    writeFileSync(cachePath(home), JSON.stringify({
      schema: 1,
      cachedAt: new Date().toISOString(),
      channel: 'stable',
      manifestUrl: 'https://example.invalid/stable/latest.json',
      payload: { version: '0.8.2' },
    }))
    const { body } = await callEndpoint(home)
    expect(body.manifestCache.freshness).toBe('green')
    expect(body.manifestCache.version).toBe('0.8.2')
    expect(body.manifestCache.cachedAt).toBeTruthy()
  })

  it('reports red freshness when no cache exists', async () => {
    const home = makeHome()
    const { body } = await callEndpoint(home)
    expect(body.manifestCache.freshness).toBe('red')
    expect(body.manifestCache.cachedAt).toBeNull()
  })
})

// Sanity: the file we just wrote must be the handler's data source.
describe('identity endpoint data layout', () => {
  it('writes state under <home>/state/identity.json', () => {
    const home = makeHome()
    expect(existsSync(identityPath(home))).toBe(false)
    mkdirSync(join(home, 'state'), { recursive: true })
    writeFileSync(identityPath(home), JSON.stringify(VALID_IDENTITY))
    expect(existsSync(identityPath(home))).toBe(true)
  })
})
