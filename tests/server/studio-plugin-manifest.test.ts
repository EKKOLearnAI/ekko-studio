import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { installPackage, readManifest } from '../../packages/server/src/modules/studio/services/plugins/installer'
import { manifest } from '../../packages/server/src/modules/studio/services/plugins/schema'
import type { PluginManifest } from '../../packages/plugin-sdk/src'

const directories: string[] = []
const definition: PluginManifest = { id: 'workspace', name: 'Workspace', version: '1.0.0', apiVersion: 1, client: 'client.mjs', permissions: ['ui'],
  author: { name: 'Author', url: 'https://example.com/author' }, repository: 'https://example.com/repo', keywords: ['chat'], icon: 'icon.png',
  views: [{ id: 'home', title: 'Home', slot: 'workspace', icon: 'grid' }, { id: 'preferences', title: 'Preferences', slot: 'settings' }], workspace: { sidebar: 'rooms' }, navigation: { main: [{ viewId: 'home', icon: 'icon.png' }], settings: [{ viewId: 'preferences', icon: 'settings' }] } }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'plugin-manifest-')); directories.push(root)
  const source = join(root, 'source'); await mkdir(source)
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'workspace', version: '1.0.0', type: 'module' }))
  await writeFile(join(source, 'plugin.json'), JSON.stringify(definition))
  await writeFile(join(source, 'client.mjs'), 'export function mount(root) { root.textContent = "workspace" }')
  await writeFile(join(source, 'icon.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aUioAAAAASUVORK5CYII=', 'base64'))
  return { root, source }
}
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }) })

it('installs standalone metadata and bundled icons without modifying the source package', async () => {
  const { root, source } = await fixture()
  const installed = await installPackage(join(root, 'host'), source)
  expect(installed.manifest).toMatchObject({ repository: definition.repository, author: definition.author, workspace: { sidebar: 'rooms' } })
  expect(installed.manifest.icon).toMatch(/^data:image\/png;base64,/)
  expect(installed.manifest.navigation?.main?.[0].icon).toBe(installed.manifest.icon)
  expect(installed.manifest.navigation?.settings?.[0].icon).toBe('settings')
  expect(installed.manifest.views?.[0].icon).toBe('grid')
  expect(JSON.parse(await readFile(join(source, 'plugin.json'), 'utf8')).icon).toBe('icon.png')
  await installed.dispose()
})

it('separates page declarations from navigation and requires explicit, suitable icons for sidebar entries', () => {
  const { navigation: _navigation, workspace: _workspace, ...standalone } = definition
  expect(manifest(standalone).navigation).toBeUndefined()
  expect(() => manifest({ ...definition, navigation: undefined })).toThrow(/JSON/)
  const agentView = { id: 'skills', title: 'Skills', slot: 'agent-settings', icon: 'skills' }
  expect(manifest({ ...definition, views: [...definition.views!, agentView] }).views?.at(-1)).toEqual(agentView)
  for (const navigation of [
    { main: [{ viewId: 'home' }] }, { settings: [{ viewId: 'preferences' }] },
    { settings: [{ viewId: 'preferences', icon: 'icon.png' }] },
    { settings: [{ viewId: 'preferences', icon: 'unknown-icon' }] },
    { main: [{ viewId: 'missing', icon: 'grid' }] },
    { main: [{ viewId: 'home', icon: 'grid' }, { viewId: 'home', icon: 'chat' }] },
    { main: [{ viewId: 'home', icon: 'https://example.com/icon.png' }] },
  ]) expect(() => manifest({ ...definition, navigation })).toThrow()
  for (const icon of [undefined, 'icon.png', '<svg/>']) {
    const { icon: _icon, ...view } = agentView
    expect(() => manifest({ ...standalone, views: [{ ...view, ...(icon === undefined ? {} : { icon }) }] })).toThrow(/named icon/)
  }
})

it('requires plugin.json even when package.json contains plugin metadata', async () => {
  const { source } = await fixture()
  await writeFile(join(source, 'package.json'), JSON.stringify({ studioPlugin: definition }))
  await rm(join(source, 'plugin.json'))
  await expect(readManifest(source)).rejects.toThrow('Plugin package must include plugin.json')
})

it('rejects mismatched package and plugin versions', async () => {
  const { source } = await fixture()
  await writeFile(join(source, 'package.json'), JSON.stringify({ version: '2.0.0' }))
  await expect(readManifest(source)).rejects.toThrow(/versions must match/)
})

it('accepts an optional dedicated MCP name and rejects invalid or reserved names', () => {
  const toolPlugin = { ...definition, permissions: ['ui', 'tools'] }
  expect(manifest(toolPlugin).mcp).toBeUndefined()
  for (const name of ['notebook-tools', 'my_tools', 'ekko-studio-plugins']) {
    expect(manifest({ ...toolPlugin, mcp: { name } }).mcp).toEqual({ name })
  }
  for (const mcp of [null, [], {}, { name: '' }, { name: 'has.dot' }, { name: 'has space' }, { name: 'UPPER' }, { name: 'x'.repeat(65) },
    { name: 'constructor' }, { name: 'ekko-studio-api' }, { name: 'hermes-studio-browser' }, { name: 'hermes-web-ui-mcp' }, { name: 'tools', command: 'custom' }]) {
    expect(() => manifest({ ...toolPlugin, mcp })).toThrow(/MCP/)
  }
  expect(() => manifest({ ...definition, mcp: { name: 'tools' } })).toThrow(/tools capability/)
})

it('rejects unsafe project links, removed chat slots and invalid navigation declarations', () => {
  for (const patch of [
    { repository: 'javascript:alert(1)' }, { documentation: 'https://user:password@example.com' }, { icon: '../secret.png' },
    { views: [{ id: 'chat', title: 'Chat', slot: 'sidebar' }] }, { views: [{ id: 'message', title: 'Message', slot: 'message' }] },
    { views: [{ id: 'home', title: 'Home', slot: 'page' }] }, { workspace: { sidebar: 'home' } }, { views: {} },
  ]) expect(() => manifest({ ...definition, ...patch })).toThrow()
})

it('rejects icon and manifest symlinks escaping the plugin package', async () => {
  const { root, source } = await fixture()
  await writeFile(join(root, 'outside.png'), 'outside')
  await rm(join(source, 'icon.png')); await symlink(join(root, 'outside.png'), join(source, 'icon.png'))
  await expect(readManifest(source)).rejects.toThrow(/escapes/)
  await writeFile(join(root, 'outside.json'), JSON.stringify(definition))
  await rm(join(source, 'plugin.json')); await symlink(join(root, 'outside.json'), join(source, 'plugin.json'))
  await expect(readManifest(source)).rejects.toThrow(/escapes/)
})

it('generates an installable minimal settings plugin with a single manifest', async () => {
  const { root } = await fixture(); const target = join(root, 'generated')
  await promisify(execFile)(process.execPath, [resolve('scripts/create-plugin.mjs'), target, 'my-plugin'])
  const installed = await installPackage(join(root, 'host'), target)
  try {
    expect(installed.manifest).toMatchObject({ id: 'my-plugin', permissions: ['ui'], views: [{ id: 'settings', title: 'my-plugin', slot: 'settings' }] })
    expect(installed.manifest.workspace).toBeUndefined()
  } finally { await installed.dispose() }
  expect(JSON.parse(await readFile(join(target, 'package.json'), 'utf8')).studioPlugin).toBeUndefined()
})
