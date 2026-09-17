import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parse } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })))

const suffixes = ['arm64.zip', 'arm64.dmg', 'x64.zip', 'x64.dmg']

function generate(workflow: string, names: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'studio-release-test-'))
  dirs.push(dir)
  const config = parse(readFileSync(resolve('.github/workflows', workflow), 'utf8'))
  const steps = Object.values(config.jobs).flatMap((job: any) => job.steps)
  const step = steps.find((step: any) => step.name === 'Generate merged latest-mac.yml') as any
  const source = step.run.split("node <<'NODE'\n")[1].split('\nNODE')[0]
    .replace("'/tmp/hermes-mac-assets'", JSON.stringify(dir))
    .replace("'/tmp/latest-mac.yml'", JSON.stringify(join(dir, 'latest-mac.yml')))
  names.forEach(name => writeFileSync(join(dir, name), `fixture:${name}`))
  const result = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8' })
  return { result, dir }
}

describe.each(['desktop-mac-update-manifest.yml', 'desktop-manual-build.yml'])('%s', workflow => {
  it('generates an intact manifest for Ekko assets', () => {
    const names = suffixes.map(suffix => `Ekko.Studio-0.7.23-${suffix}`)
    const { result, dir } = generate(workflow, names)
    expect(result.status, result.stderr).toBe(0)
    const manifest = parse(readFileSync(join(dir, 'latest-mac.yml'), 'utf8'))
    expect(manifest.version).toBe('0.7.23')
    expect(manifest.path).toBe(names[0])
    expect(manifest.files).toEqual(names.map(url => ({
      url,
      sha512: createHash('sha512').update(`fixture:${url}`).digest('base64'),
      size: Buffer.byteLength(`fixture:${url}`),
    })))
    expect(manifest.sha512).toBe(manifest.files[0].sha512)
  })

  it('rejects missing architectures and mixed versions', () => {
    const names = suffixes.map(suffix => `Ekko.Studio-0.7.23-${suffix}`)
    const missing = generate(workflow, names.slice(0, 2)).result
    expect(missing.status).not.toBe(0)
    expect(missing.stderr).toContain('Missing macOS release assets')
    const mixed = generate(workflow, [...names, 'Ekko.Studio-0.7.22-arm64.zip']).result
    expect(mixed.status).not.toBe(0)
    expect(mixed.stderr).toContain('Mixed macOS asset versions')
  })
})
