import { expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mergePluginMcpServers } from '../../packages/server/src/modules/studio/public/plugin-mcp'
import { createOpenCodeConfig } from '../../packages/server/src/modules/coding-agents/services/opencode/config'
import { prepareDshRuntime } from '../../packages/server/src/modules/coding-agents/services/dsh/runtime-config'
import { readDshMcpServers, updateDshMcpServer } from '../../packages/server/src/modules/coding-agents/services/dsh/config'

const pluginServer = (field = 'env') => ({ command: 'node', [field]: { HERMES_WEB_UI_MANAGED_MCP: '1', HERMES_MCP_TOOLSET: 'plugins' } })

it('preserves same-name external servers while refreshing dedicated plugin servers and removing stale definitions', () => {
  const user = { command: 'user-owned' }, desired = pluginServer()
  const existing = { external: user, 'notes-tools': user, stale: pluginServer('environment'), refresh: pluginServer() }
  const merged = mergePluginMcpServers(existing, { 'notes-tools': desired, refresh: desired, fresh: desired })
  expect(merged).toEqual({ external: user, 'notes-tools': user, refresh: desired, fresh: desired })
  expect(existing).toHaveProperty('stale')
  expect(mergePluginMcpServers(merged, {})).toEqual({ external: user, 'notes-tools': user })
})

it('generates OpenCode configuration with dedicated tools without shadowing user MCPs or retaining removed plugins', () => {
  const user = { type: 'local', command: ['user-owned'] }
  const desired = { 'notes-tools': pluginServer('environment'), fresh: pluginServer('environment') }
  const { opencodeRuntimeConfig } = createOpenCodeConfig({
    managedServerNames: new Set(['ekko-studio-plugins']), managedMcp: () => desired, displayNameForModel: model => model,
  })
  const result = JSON.parse(opencodeRuntimeConfig('work', {}, JSON.stringify({ mcp: {
    'notes-tools': user, stale: pluginServer('environment'), external: user,
  } })))
  expect(result.mcp).toEqual({ 'notes-tools': user, fresh: desired.fresh, external: user })
})

it('prepares DSH YAML with dedicated tools, preserves collisions, and drops removed plugin MCPs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-mcp-routing-'))
  try {
    const sourceHome = join(dir, 'source'), rootDir = join(dir, 'runtime')
    await mkdir(sourceHome)
    let patch = updateDshMcpServer('[]\n', 'notes-tools', { command: 'user-owned' })
    patch = updateDshMcpServer(patch, 'stale', pluginServer())
    await writeFile(join(sourceHome, 'cordis.patch.yml'), patch)
    const fresh = pluginServer()
    await prepareDshRuntime({ sourceHome, rootDir, sharedSkills: join(dir, 'skills'), systemPrompt: 'test', managedMcp: { 'notes-tools': pluginServer(), fresh } })
    const servers = readDshMcpServers(await readFile(join(rootDir, 'cordis.patch.yml'), 'utf8'))
    expect(servers.get('notes-tools')?.command).toBe('user-owned')
    expect(servers.has('stale')).toBe(false)
    expect(servers.get('fresh')).toMatchObject(fresh)
    expect(await readFile(join(sourceHome, 'cordis.patch.yml'), 'utf8')).toBe(patch)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
