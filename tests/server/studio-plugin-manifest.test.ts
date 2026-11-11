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
const definition: PluginManifest = { id: 'workspace', name: 'Workspace', version: '1.0.0', apiVersion: 1, client: 'client.mjs', capabilities: ['ui'],
  author: { name: 'Author', url: 'https://example.com/author' }, repository: 'https://example.com/repo', keywords: ['chat'], icon: 'icon.png',
  views: [{ id: 'home', title: 'Home', slot: 'workspace' }, { id: 'preferences', title: 'Preferences', slot: 'settings' }], workspace: { sidebar: 'rooms' } }
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
  expect(JSON.parse(await readFile(join(source, 'plugin.json'), 'utf8')).icon).toBe('icon.png')
  await installed.dispose()
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

it('generates an installable plugin with a single manifest and its own workspace', async () => {
  const { root } = await fixture(); const target = join(root, 'generated')
  await promisify(execFile)(process.execPath, [resolve('scripts/create-plugin.mjs'), target, 'my-plugin'])
  expect((await readManifest(target))).toMatchObject({ id: 'my-plugin', workspace: { sidebar: 'note-list' }, views: expect.arrayContaining([expect.objectContaining({ slot: 'settings' })]) })
  expect(JSON.parse(await readFile(join(target, 'package.json'), 'utf8')).studioPlugin).toBeUndefined()
})
