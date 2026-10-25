import { join } from 'node:path'
import type { AgentManagementAdapter } from '@ekko-studio/plugin-sdk'
import { directories } from './configuration'

export const locations: NonNullable<AgentManagementAdapter['locations']> = async ({ config, mode }, context) => {
  const { root } = directories(config, mode, context), cwd = String(config.cwd)
  return { skills: [
    { id: 'native-skills', name: 'Claude Code skills', path: join(root, 'skills'), scope: mode, readOnly: false },
    { id: 'workspace-skills', name: 'Workspace Claude skills', path: join(cwd, '.claude', 'skills'), scope: 'workspace', readOnly: false },
  ], configs: [
    { id: 'native-commands', name: 'Claude Code commands', path: join(root, 'commands'), scope: mode, readOnly: false, kind: 'directory', format: 'markdown' },
    { id: 'workspace-commands', name: 'Workspace Claude commands', path: join(cwd, '.claude', 'commands'), scope: 'workspace', readOnly: false, kind: 'directory', format: 'markdown' },
    ...['settings.json', 'mcp.json', 'CLAUDE.md', 'hermes-rules.md'].map((name, i) => ({ id: ['native-settings', 'native-mcp', 'native-instructions', 'native-prompt'][i], name,
      path: join(root, name), scope: mode, readOnly: false, kind: 'file' as const, format: name.endsWith('.md') ? 'markdown' : 'json' })),
    ...['.claude/settings.json', '.claude/settings.local.json', '.mcp.json', 'CLAUDE.md', '.claude/CLAUDE.md'].map((name, i) => ({
      id: `workspace-config-${i}`, name, path: join(cwd, name), scope: 'workspace' as const, readOnly: false, kind: 'file' as const,
      format: name.endsWith('.md') ? 'markdown' : 'json' })),
  ] }
}
