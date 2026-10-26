import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readDshBundlePatches } from '../../packages/server/src/modules/coding-agents/services/dsh/bundle'
import { readNativeDshPluginInventory } from '../../packages/server/src/modules/coding-agents/services/dsh/plugin-inventory'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-registry-')); roots.push(root)
  // npm global Windows layout: dependencies are nested under the CLI package,
  // not siblings beside it in the outer @deepseek-ai directory.
  const cli = join(root, 'node_modules/@deepseek-ai/dsh')
  const web = join(cli, 'node_modules/@deepseek-ai/dsh-web-app')
  const base = join(cli, 'node_modules/@deepseek-ai/dsh-base')
  const home = join(root, 'home')
  await Promise.all([web, base, home].map(path => mkdir(path, { recursive: true })))
  const command = join(root, 'dsh.cmd')
  await writeFile(command, '')
  await writeFile(join(cli, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.7-rc.2' }))
  await writeFile(join(base, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-base', dsh: { bundle: { patch: './base.yml' } } }))
  await writeFile(join(base, 'base.yml'), '[]\n')
  await writeFile(join(web, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-web-app', dsh: { bundle: { patch: ['./host.yml', './standard.yml'] } } }))
  await writeFile(join(web, 'host.yml'), '- insert:\n    - id: agent-preset-registry\n      name: "@deepseek-ai/dsh-agent-preset-registry"\n      config:\n        default: standard\n')
  await writeFile(join(web, 'standard.yml'), '- insert:\n    - id: preset-standard\n      name: "@deepseek-ai/dsh-agent-preset"\n      config:\n        id: standard\n        plugins:\n          - id: shell\n            name: fixture-shell\n            disabled: !!js process.platform === "win32"\n')
  return { root, command, web, home }
}

it('loads ordered bundle patch lists and discovers nested declaration-based presets without executing expressions', async () => {
  const input = await fixture()
  const before = await readFile(join(input.web, 'standard.yml'), 'utf8')
  expect((await readDshBundlePatches(input.web)).map(layer => layer.path)).toEqual([join(input.web, 'host.yml'), join(input.web, 'standard.yml')])
  const inventory = await readNativeDshPluginInventory(input.command, input.home)
  expect(inventory).toMatchObject({ packageVersion: '0.1.7-rc.2', discovery: 'bundle-declarations', defaultPreset: 'standard', presets: [
    { id: 'standard', isDefault: true, trust: 'system', entries: [{ entryId: 'shell', configuredEnabled: 'conditional' }] },
  ] })
  expect(await readFile(join(input.web, 'standard.yml'), 'utf8')).toBe(before)
})

it('includes profile declarations and applies selectedDefault without inventing legacy preset directories', async () => {
  const input = await fixture()
  await mkdir(join(input.home, 'profiles/web'), { recursive: true })
  await writeFile(join(input.home, 'profiles/web/cordis.patch.yml'), '- id: agent-preset-registry\n  config:\n    default: standard\n    selectedDefault: custom\n- insert:\n    - id: preset-custom\n      name: "@deepseek-ai/dsh-agent-preset"\n      config:\n        id: custom\n        plugins:\n          - id: tool\n            name: fixture-tool\n            disabled: false\n')
  const inventory = await readNativeDshPluginInventory(input.command, input.home)
  expect(inventory.defaultPreset).toBe('custom')
  expect(inventory.presets.find(row => row.id === 'custom')).toMatchObject({ trust: 'user', isDefault: true, entries: [{ configuredEnabled: true }] })
  expect(inventory.presets.find(row => row.id === 'standard')?.isDefault).toBe(false)
})

it.each([[], ['host.yml', 7], null])('rejects malformed native patch metadata %j', async patch => {
  const input = await fixture()
  await writeFile(join(input.web, 'package.json'), JSON.stringify({ name: 'fixture-web', dsh: { bundle: { patch } } }))
  await expect(readDshBundlePatches(input.web)).rejects.toMatchObject({ code: 'DSH_CAPABILITY_UNSUPPORTED' })
})
