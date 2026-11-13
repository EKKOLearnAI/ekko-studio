/**
 * Tests for the identity repair endpoint (phase a drift repair).
 *
 * Master spec: docs/harness/source-deploy-refactor.md (§ Stage State →
 * Identity drift). Repair is ALWAYS "re-stamp from the current deploy",
 * never "force reinstall". A tree without a readable version/dist refuses
 * with 409 instead of stamping garbage.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterAll, describe, expect, it } from 'vitest'

const tempDirs: string[] = []
const ORIGINAL_ENV = { ...process.env }

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'identity-repair-'))
  tempDirs.push(dir)
  return dir
}

function makeDeployTree(home: string, version: string): string {
  const deployDir = join(home, 'deploy')
  mkdirSync(join(deployDir, 'dist', 'server'), { recursive: true })
  writeFileSync(join(deployDir, 'package.json'), JSON.stringify({ name: 'hermes-web-ui', version }))
  writeFileSync(join(deployDir, 'dist', 'server', 'index.js'), `console.log("${version}")`)
  return deployDir
}

async function repair(deployDir: string, home: string): Promise<{ status?: number; body: any }> {
  process.env.HERMES_WEB_UI_HOME = home
  const { repairUpdateIdentity } = await import('../../packages/server/src/modules/studio/controllers/update')
  const ctx: any = {}
  ;(global as any).__testDeployDir = deployDir
  // getDeployDir resolves DEPLOY_DIR env first.
  process.env.DEPLOY_DIR = deployDir
  await repairUpdateIdentity(ctx)
  return { status: ctx.status, body: ctx.body }
}

afterAll(() => {
  process.env = { ...ORIGINAL_ENV }
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('POST /api/update/identity/repair', () => {
  it('re-stamps identity from the current deploy tree', async () => {
    const home = makeHome()
    const deployDir = makeDeployTree(home, '0.9.1')
    // Stale identity from the previous run.
    mkdirSync(join(home, 'state'), { recursive: true })
    writeFileSync(join(home, 'state', 'identity.json'), JSON.stringify({
      schema: 1, capturedAt: '2026-09-01T00:00:00Z', version: '0.9.0',
      distSha256: 'a'.repeat(64), installerScriptSha256: '', agentManifestSha: '0.0.0-noop',
    }))

    const { status, body } = await repair(deployDir, home)
    expect(status).toBeUndefined()
    expect(body.success).toBe(true)
    expect(body.identity.version).toBe('0.9.1')
    expect(body.identity.agentManifestSha).toBe('0.0.0-noop')
    expect(body.identity.distSha256).toMatch(/^[a-f0-9]{64}$/)

    // The file on disk was rewritten atomically.
    const persisted = JSON.parse(readFileSync(join(home, 'state', 'identity.json'), 'utf8'))
    expect(persisted.version).toBe('0.9.1')
  })

  it('refuses (409) when the deploy tree has no readable version', async () => {
    const home = makeHome()
    const deployDir = join(home, 'deploy')
    mkdirSync(join(deployDir, 'dist', 'server'), { recursive: true })
    writeFileSync(join(deployDir, 'dist', 'server', 'index.js'), 'orphan dist, no package.json')

    const { status, body } = await repair(deployDir, home)
    expect(status).toBe(409)
    expect(body.success).toBe(false)
    expect(body.code).toBe('update_identity_unstampable')
    // No garbage identity.json was written.
    expect(existsSync(join(home, 'state', 'identity.json'))).toBe(false)
  })

  it('refuses (409) when the deploy tree has no dist/', async () => {
    const home = makeHome()
    const deployDir = join(home, 'deploy')
    mkdirSync(deployDir, { recursive: true })
    writeFileSync(join(deployDir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }))

    const { status, body } = await repair(deployDir, home)
    expect(status).toBe(409)
    expect(body.code).toBe('update_identity_unstampable')
  })

  it('repair is idempotent: stamping twice yields the same identity fields', async () => {
    const home = makeHome()
    const deployDir = makeDeployTree(home, '0.9.2')
    const first = await repair(deployDir, home)
    const second = await repair(deployDir, home)
    expect(first.body.identity.distSha256).toBe(second.body.identity.distSha256)
    expect(second.body.success).toBe(true)
  })
})
