import { join } from 'node:path'
import type { AgentManagementAdapter } from '@ekko-studio/plugin-sdk'
import { directories } from './configuration'

export const locations: NonNullable<AgentManagementAdapter['locations']> = async ({ config, mode }, context) => {
  const { home, root } = directories(config, mode, context), cwd = String(config.cwd)
  return { skills: [
    { id: 'native-skills', name: 'Pi skills', path: join(root, 'skills'), scope: mode, readOnly: false },
    { id: 'shared-skills', name: 'Shared skills', path: join(home, '.agents', 'skills'), scope: 'shared', readOnly: true },
    { id: 'workspace-skills', name: 'Pi project skills', path: join(cwd, '.pi', 'skills'), scope: 'workspace', readOnly: false },
    { id: 'workspace-shared-skills', name: 'Shared project skills', path: join(cwd, '.agents', 'skills'), scope: 'workspace', readOnly: false },
  ], configs: [
    ...['settings.json', 'models.json', 'mcp.json', 'AGENTS.md', 'APPEND_SYSTEM.md'].map((name, index) => ({
      id: index === 3 ? 'native-instructions' : `native-config-${index}`, name, path: join(root, name), scope: mode, readOnly: false, kind: 'file' as const,
      format: name.endsWith('.json') ? 'json' : 'markdown' })),
    ...['.pi/settings.json', '.pi/mcp.json', 'AGENTS.md', 'CLAUDE.md'].map((name, index) => ({
      id: `workspace-config-${index}`, name, path: join(cwd, name), scope: 'workspace' as const, readOnly: false, kind: 'file' as const,
      format: name.endsWith('.json') ? 'json' : 'markdown' })),
  ] }
}
