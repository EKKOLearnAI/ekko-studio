import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { StudioError, type AgentManagementAdapter, type JsonObject } from '@ekko-studio/plugin-sdk'

export function qoderDirectories(config: JsonObject) {
  const env = (config.env || {}) as Record<string, string>, cwd = String(config.cwd)
  const home = env.HOME || env.USERPROFILE || homedir()
  const name = (env.QODER_CONFIG_DIR_NAME || '.qoder').normalize('NFC')
  if ([...name].length > 64 || !/^[\p{L}\p{N}\p{M}_.-](?:[\p{L}\p{N}\p{M}_. -]*[\p{L}\p{N}\p{M}_-])?$/u.test(name)
    || ['.', '..', '.git', '.svn', '.hg', '.vscode', '.idea', '.husky', '.github', 'node_modules', 'bower_components'].includes(name.toLowerCase())
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Qoder configuration directory name')
  const args = config.args as string[] || []
  let override: string | undefined
  for (let index = 0; index < args.length && args[index] !== '--'; index++) {
    if (args[index].startsWith('--config-dir=')) override = args[index].slice('--config-dir='.length)
    else if (args[index] === '--config-dir') override = args[++index] || ''
  }
  const root = override ?? (env.QODER_CONFIG_DIR || join(env.QODER_CLI_HOME || home, name))
  if (![cwd, home, root].every(isAbsolute)) throw new StudioError('INVALID_ARGUMENT', 'Qoder resource directories must be absolute')
  return { home, root, cwd, project: join(cwd, name) }
}

export const locations: NonNullable<AgentManagementAdapter['locations']> = async ({ config, mode }) => {
  if (mode !== 'global') throw new StudioError('CAPABILITY_UNSUPPORTED', 'Qoder requires a native account instance')
  const { home, root, cwd, project } = qoderDirectories(config)
  return { skills: [
    { id: 'native-skills', name: 'Qoder skills', path: join(root, 'skills'), scope: 'global', readOnly: false },
    { id: 'workspace-skills', name: 'Qoder workspace skills', path: join(project, 'skills'), scope: 'workspace', readOnly: false },
    { id: 'shared-skills', name: 'Shared skills', path: join(home, '.agents', 'skills'), scope: 'shared', readOnly: true },
    { id: 'workspace-shared-skills', name: 'Workspace shared skills', path: join(cwd, '.agents', 'skills'), scope: 'workspace', readOnly: false },
  ], configs: [
    { id: 'native-config', name: 'Qoder settings.json', path: join(root, 'settings.json'), scope: 'global', readOnly: false, kind: 'file', format: 'json' },
    { id: 'native-memory', name: 'Qoder memory.md', path: join(root, 'memory.md'), scope: 'global', readOnly: false, kind: 'file', format: 'markdown' },
    { id: 'workspace-config', name: 'Qoder project settings', path: join(project, 'settings.json'), scope: 'workspace', readOnly: false, kind: 'file', format: 'json' },
    { id: 'workspace-local-config', name: 'Qoder local settings', path: join(project, 'settings.local.json'), scope: 'workspace', readOnly: false, kind: 'file', format: 'json' },
    { id: 'workspace-mcp', name: 'Qoder MCP', path: join(cwd, '.mcp.json'), scope: 'workspace', readOnly: false, kind: 'file', format: 'json' },
    { id: 'workspace-instructions', name: 'AGENTS.md', path: join(cwd, 'AGENTS.md'), scope: 'workspace', readOnly: false, kind: 'file', format: 'markdown' },
  ] }
}
