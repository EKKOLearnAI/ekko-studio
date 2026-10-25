import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { StudioError, type AgentContextConfiguration, type AgentRuntimeContext, type JsonObject } from '@ekko-studio/plugin-sdk'

export const cursorVersion = '2026.10.22-27dcf5f'
export const installationUrl = 'https://cursor.com/docs/cli/installation'

export function directories(config: JsonObject) {
  const env = config.env as Record<string, string> || {}, home = env.HOME || env.USERPROFILE || homedir()
  const root = env.CURSOR_CONFIG_DIR || (env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, 'cursor') : join(home, '.cursor'))
  if (![home, root, String(config.cwd)].every(isAbsolute)) throw new StudioError('INVALID_ARGUMENT', 'Cursor directories must be absolute')
  return { home, root: resolve(root) }
}

/** Protocol and resume switches belong to the plugin, not saved launch arguments. */
export function validateArguments(args: string[]) {
  const reserved = ['-p', '--print', '--output-format', '--stream-partial-output', '--resume', '--continue', '--image', '--workspace', '-w', '--worktree']
  if (args.some(arg => reserved.some(flag => arg === flag || arg.startsWith(`${flag}=`)))) throw new StudioError('INVALID_ARGUMENT', 'Cursor launch arguments conflict with its managed protocol or session')
}

export async function prepareCursor(config: JsonObject, context: AgentRuntimeContext, configuration: AgentContextConfiguration) {
  directories(config)
  if (!context.stateDirectory) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Cursor requires host-managed auxiliary storage')
  await mkdir(context.stateDirectory, { recursive: true, mode: 0o700 })
  const path = await mkdtemp(join(context.stateDirectory, 'cursor-turn-')), args: string[] = []
  try {
    const servers: Record<string, unknown> = Object.create(null)
    for (const [name, entry] of Object.entries(configuration.mcpServers || {})) {
      if (entry.enabled === false || entry.disabled) continue
      const { enabled: _enabled, disabled: _disabled, ...server } = entry
      servers[name] = 'url' in server ? { ...server, type: server.type === 'streamable_http' ? 'http' : server.type || 'http' } : server
    }
    if (Object.keys(servers).length) {
      await mkdir(join(path, '.cursor-plugin'), { mode: 0o700 })
      await writeFile(join(path, '.cursor-plugin/plugin.json'), JSON.stringify({ name: 'studio-runtime', version: '0.1.0', mcpServers: 'mcp.json', description: 'Run-bound Studio MCP connections' }), { mode: 0o600 })
      await writeFile(join(path, 'mcp.json'), JSON.stringify({ mcpServers: servers }), { mode: 0o600 })
      args.push('--approve-mcps', '--plugin-dir', path)
    }
    if (config.model) args.push('--model', String(config.model))
    return { path, args: ['--disable-auto-update', ...args], env: { ...config.env as Record<string, string> }, dispose: () => rm(path, { recursive: true, force: true }) }
  } catch (error) { await rm(path, { recursive: true, force: true }); throw error }
}
