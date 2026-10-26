import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('supported packaging targets', () => {
  it('does not expose retired TerraMaster packaging or publishing entrypoints', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(pkg.scripts['pack:tos']).toBeUndefined()
    expect(pkg.scripts['verify:tos']).toBeUndefined()
    for (const path of ['packages/tos/config.json', '.github/workflows/tos-package-test.yml', 'scripts/pack-tos-deb.mjs', 'scripts/test-tos-platform.mjs']) {
      expect(existsSync(path)).toBe(false)
    }
  })
  it('retains desktop, Docker and Web UI release targets and the shared privacy notice', () => {
    for (const path of ['Dockerfile', '.github/workflows/desktop-release.yml', '.github/workflows/webui-release.yml', 'PRIVACY.md']) {
      expect(existsSync(path)).toBe(true)
    }
  })
})
