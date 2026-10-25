import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { StudioError, type AgentManagementAdapter } from '@ekko-studio/plugin-sdk'

export const locations: NonNullable<AgentManagementAdapter['locations']> = async ({ config, mode }, context) => {
  const env = (config.env || {}) as Record<string, string>, cwd = String(config.cwd)
  const home = mode === 'scoped' ? context.stateDirectory && join(context.stateDirectory, 'home') : env.HOME || env.USERPROFILE || homedir()
  const root = mode === 'scoped' ? context.stateDirectory && join(context.stateDirectory, 'opencode')
    : env.OPENCODE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home!, '.config'), 'opencode')
  const global = mode === 'scoped' ? home && join(home, '.config', 'opencode') : join(env.XDG_CONFIG_HOME || join(home!, '.config'), 'opencode')
  if (!home || !root || !global) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Scoped resources require host-managed storage')
  const custom = mode === 'global' ? env.OPENCODE_CONFIG : undefined
  if (![cwd, home, root, global, ...(custom ? [custom] : [])].every(isAbsolute)) throw new StudioError('INVALID_ARGUMENT', 'OpenCode resource directories must be absolute')
  return { skills: [
    { id: 'native-skills', name: 'OpenCode skills', path: join(root, 'skills'), scope: mode, readOnly: false },
    ...(root === global ? [] : [{ id: 'global-skills', name: 'OpenCode global skills', path: join(global, 'skills'), scope: 'shared' as const, readOnly: true }]),
    { id: 'shared-skills', name: 'Shared skills', path: join(home, '.agents', 'skills'), scope: 'shared', readOnly: true },
    { id: 'claude-skills', name: 'Claude-compatible skills', path: join(home, '.claude', 'skills'), scope: 'shared', readOnly: true },
    ...['.opencode', '.agents', '.claude'].map((name, i) => ({ id: `workspace-skills-${i}`, name: `${name} skills`, path: join(cwd, name, 'skills'), scope: 'workspace' as const, readOnly: false })),
  ], configs: [
    { id: 'native-config', name: 'OpenCode configuration', path: join(root, 'opencode.json'), scope: mode, readOnly: false, kind: 'file', format: 'json' },
    { id: 'native-config-jsonc', name: 'OpenCode JSONC configuration', path: join(root, 'opencode.jsonc'), scope: mode, readOnly: false, kind: 'file', format: 'jsonc' },
    { id: 'native-instructions', name: 'OpenCode instructions', path: join(root, 'AGENTS.md'), scope: mode, readOnly: false, kind: 'file', format: 'markdown' },
    ...(root === global ? [] : [{ id: 'global-config', name: 'OpenCode global configuration', path: join(global, 'opencode.json'), scope: 'shared' as const, readOnly: true, kind: 'file' as const, format: 'json' }]),
    ...(custom ? [{ id: 'custom-config', name: 'OpenCode custom configuration', path: custom, scope: 'global' as const, readOnly: false, kind: 'file' as const, format: 'jsonc' }] : []),
    ...['opencode.json', 'opencode.jsonc', '.opencode/opencode.json', '.opencode/opencode.jsonc', 'AGENTS.md'].map((name, i) => ({
      id: `workspace-config-${i}`, name, path: join(cwd, name), scope: 'workspace' as const, readOnly: false, kind: 'file' as const,
      format: name.endsWith('.md') ? 'markdown' : name.endsWith('.jsonc') ? 'jsonc' : 'json' })),
  ] }
}
