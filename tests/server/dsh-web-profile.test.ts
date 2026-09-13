import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareDshManagementProfile } from '../../packages/server/src/modules/coding-agents/services/dsh/management-profile'
import { prepareDshWebProfile } from '../../packages/server/src/modules/coding-agents/services/dsh/web-profile'

vi.mock('../../packages/server/src/modules/coding-agents/services/dsh/acp-adapter', () => ({ writeDshAcpAdapter: vi.fn() }))
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-web-source-')); roots.push(root)
  const sourceHome = join(root, 'native'), rootDir = join(root, 'private')
  const cli = join(root, 'node_modules/@deepseek-ai/dsh')
  const profile = join(sourceHome, 'profiles/web')
  const bundle = join(profile, 'node_modules/my-web-plugin')
  await Promise.all([join(cli, 'lib'), profile, bundle].map(path => mkdir(path, { recursive: true })))
  const command = join(cli, 'lib/bin.js')
  await writeFile(command, '')
  await writeFile(join(cli, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }))
  for (const name of ['dsh-base', 'dsh-web-app', 'dsh-acp-app']) {
    const directory = join(root, 'node_modules/@deepseek-ai', name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    await writeFile(join(directory, 'cordis.patch.yml'), name === 'dsh-web-app'
      ? '- insert:\n  - id: webserver\n    name: webserver\n  - id: agent-presets\n    name: presets\n    config:\n      default: standard\n' : '[]\n')
  }
  const manifest = { dependencies: { 'my-web-plugin': '1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'my-web-plugin'] } } }
  await writeFile(join(profile, 'package.json'), JSON.stringify(manifest))
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'my-web-plugin', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  await writeFile(join(bundle, 'cordis.patch.yml'), '[]\n')
  const patch = '- insert:\n  - id: local-plugin\n    name: ./local.mjs\n    disabled: !!js process.env.DISABLE_LOCAL\n- id: agent-presets\n  config:\n    default: custom\n    roots:\n      - path: /external/presets\n        trust: user\n'
  await writeFile(join(profile, 'cordis.patch.yml'), patch)
  return { command, sourceHome, rootDir, profile, bundle, patch, manifest }
}

it('keeps Web bundle order, profile-relative paths and custom preset roots without writing back', async () => {
  const input = await fixture()
  const prepared = await prepareDshWebProfile(input)
  const directory = join(input.rootDir, 'profiles', prepared.profile)
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  expect(manifest.dsh.profile).toEqual({ bundles: [...input.manifest.dsh.profile.bundles, '@deepseek-ai/dsh-acp-app'], patchReload: 'startup' })
  expect(await realpath(join(directory, 'node_modules/my-web-plugin'))).toBe(await realpath(input.bundle))
  const copied = await readFile(join(directory, 'cordis.patch.yml'), 'utf8')
  expect(copied).toContain(pathToFileURL(join(input.profile, 'local.mjs')).href)
  expect(copied).toContain('!!js process.env.DISABLE_LOCAL')
  const rows = parse(await readFile(prepared.patch, 'utf8'), { logLevel: 'silent' })
  expect(rows.find((row: any) => row.id === 'webserver').disabled).toBe(true)
  expect(rows.find((row: any) => row.id === 'agent-presets').config).toMatchObject({ default: 'custom', includeUserRoot: false,
    roots: [{ path: '/external/presets', trust: 'user' }, { path: join(input.sourceHome, '.agent-presets'), trust: 'user' }] })
  expect(rows.some((row: any) => row.id === 'local-plugin')).toBe(false)
  expect(await readFile(join(input.profile, 'cordis.patch.yml'), 'utf8')).toBe(input.patch)
  expect(await readFile(join(input.profile, 'package.json'), 'utf8')).toBe(JSON.stringify(input.manifest))
  await writeFile(join(input.profile, 'cordis.patch.yml'), '[]\n')
  expect((await prepareDshWebProfile(input)).generation).not.toBe(prepared.generation)
  expect(await readFile(join(directory, 'cordis.patch.yml'), 'utf8')).toBe(copied)
})

it('reports unresolved source dependencies instead of silently dropping Web plugins', async () => {
  const input = await fixture()
  await rm(input.bundle, { recursive: true })
  await expect(prepareDshWebProfile(input)).rejects.toMatchObject({ code: 'DSH_DEPENDENCY_UNAVAILABLE' })
})

it('uses the same persistent authoring roots in management and ACP, including home overrides', async () => {
  const input = await fixture()
  const homePatch = '- id: agent-presets\n  config:\n    default: home-preset\n    includeUserRoot: false\n    roots:\n      - path: /home-presets\n        trust: user\n'
  await writeFile(join(input.sourceHome, 'cordis.patch.yml'), homePatch)
  const management = await prepareDshManagementProfile(input)
  const acp = await prepareDshWebProfile({ ...input, rootDir: join(input.rootDir, 'acp') })
  const readPresetConfig = async (path: string) => parse(await readFile(path, 'utf8'), { logLevel: 'silent' }).find((row: any) => row.id === 'agent-presets').config
  expect(await readPresetConfig(management.patch)).toEqual(await readPresetConfig(acp.patch))
  expect(await readPresetConfig(management.patch)).toEqual({ default: 'home-preset', includeUserRoot: false, roots: [{ path: '/home-presets', trust: 'user' }] })
  expect(await readFile(join(input.sourceHome, 'cordis.patch.yml'), 'utf8')).toBe(homePatch)
})

// DSH's `dsh_plugin_packages` request extension resolves the manifest that owns each active
// plugin row and rejects one without a non-empty name or version. Every manifest Studio
// generates is loaded that way, so each must carry a version even though none is published.
it('declares a version on every generated plugin manifest', async () => {
  const input = await fixture()
  const readVersion = async (path: string) => JSON.parse(await readFile(path, 'utf8')).version

  const web = await prepareDshWebProfile(input)
  expect(await readVersion(join(input.rootDir, 'profiles', web.profile, 'package.json'))).toMatch(/^\d+\.\d+\.\d+/)

  const management = await prepareDshManagementProfile(input)
  const managementDir = join(input.rootDir, 'profiles', management.profile)
  expect(await readVersion(join(managementDir, 'package.json'))).toMatch(/^\d+\.\d+\.\d+/)
  expect(await readVersion(join(managementDir, 'node_modules/studio-dsh-ui/package.json'))).toMatch(/^\d+\.\d+\.\d+/)
})
