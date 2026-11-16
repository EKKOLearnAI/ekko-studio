import { readFileSync } from 'fs'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyMicroCompactDefault, createProfileWithoutHermes } from '../../packages/server/src/modules/hermes/services/profiles/lifecycle'
import { readAppConfig } from '../../packages/server/src/modules/studio/public/app-config'

vi.mock('../../packages/server/src/modules/studio/public/app-config', () => ({
  readAppConfig: vi.fn(async () => ({ microCompactDefault: false })),
}))

describe('applyMicroCompactDefault (micro-compact global switch)', () => {
  const originalHermesHome = process.env.HERMES_HOME
  const tempHomes: string[] = []

  afterEach(async () => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    await Promise.all(tempHomes.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  })

  async function makeHome(prefix: string): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), prefix))
    tempHomes.push(home)
    process.env.HERMES_HOME = home
    return home
  }

  it('writes the global default (on) into a new profile config', async () => {
    const home = await makeHome('mc-apply-on-')
    const r = await createProfileWithoutHermes('mc-test', false, home)
    vi.mocked(readAppConfig).mockResolvedValueOnce({ microCompactDefault: true })
    const ok = await applyMicroCompactDefault('mc-test')
    expect(ok).toBe(true)
    expect(readFileSync(join(r.path, 'config.yaml'), 'utf-8')).toContain('micro_compact: true')
  })

  it('writes the global default (off) into a new profile config', async () => {
    const home = await makeHome('mc-apply-off-')
    const r = await createProfileWithoutHermes('mc-test', false, home)
    const ok = await applyMicroCompactDefault('mc-test')
    expect(ok).toBe(true)
    expect(readFileSync(join(r.path, 'config.yaml'), 'utf-8')).toContain('micro_compact: false')
  })

  it('returns false for a profile with no config.yaml', async () => {
    const home = await makeHome('mc-apply-missing-')
    const ok = await applyMicroCompactDefault('does-not-exist')
    expect(ok).toBe(false)
  })

  it('overrides a cloned config existing micro_compact value', async () => {
    const home = await makeHome('mc-apply-clone-')
    await writeFile(join(home, 'active_profile'), 'default\n', 'utf-8')
    await writeFile(join(home, 'config.yaml'), 'compression:\n  micro_compact: false\n', 'utf-8')
    const r = await createProfileWithoutHermes('mc-clone', true, home)
    expect(readFileSync(join(r.path, 'config.yaml'), 'utf-8')).toContain('micro_compact: false')
    vi.mocked(readAppConfig).mockResolvedValueOnce({ microCompactDefault: true })
    const ok = await applyMicroCompactDefault('mc-clone')
    expect(ok).toBe(true)
    expect(readFileSync(join(r.path, 'config.yaml'), 'utf-8')).toContain('micro_compact: true')
  })

  it('preserves comments and date scalars (no full yaml round-trip)', async () => {
    const home = await makeHome('mc-apply-preserve-')
    const r = await createProfileWithoutHermes('mc-preserve', false, home)
    await writeFile(
      join(r.path, 'config.yaml'),
      '# custom header comment\ncreated: 2026-11-01\nmodel:\n  default: foo\n',
      'utf-8',
    )
    vi.mocked(readAppConfig).mockResolvedValueOnce({ microCompactDefault: true })
    const ok = await applyMicroCompactDefault('mc-preserve')
    const out = readFileSync(join(r.path, 'config.yaml'), 'utf-8')
    expect(ok).toBe(true)
    expect(out).toContain('# custom header comment')
    expect(out).toContain('created: 2026-11-01')
    expect(out).not.toContain('2026-11-01T00')
    expect(out).toContain('micro_compact: true')
  })
})
