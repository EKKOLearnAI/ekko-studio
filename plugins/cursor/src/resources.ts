import { join } from 'node:path'
import type { AgentManagementAdapter } from '@ekko-studio/plugin-sdk'
import { directories } from './configuration'

export const locations: NonNullable<AgentManagementAdapter['locations']> = async ({ config }) => {
  const { root } = directories(config), cwd = String(config.cwd)
  return { skills: [
    { id: 'native-skills', name: 'Cursor skills', path: join(root, 'skills'), scope: 'global', readOnly: false },
    { id: 'workspace-skills', name: 'Workspace Cursor skills', path: join(cwd, '.cursor/skills'), scope: 'workspace', readOnly: false },
    { id: 'shared-skills', name: 'Workspace shared skills', path: join(cwd, '.agents/skills'), scope: 'workspace', readOnly: false },
  ], configs: [
    ...['cli-config.json', 'mcp.json'].map((name, index) => ({ id: ['native-settings', 'native-mcp'][index], name, path: join(root, name), scope: 'global' as const, readOnly: false, kind: 'file' as const, format: 'json' })),
    ...['rules', 'commands'].map(name => ({ id: `native-${name}`, name, path: join(root, name), scope: 'global' as const, readOnly: false, kind: 'directory' as const, format: 'markdown' })),
    ...['.cursor/rules', '.cursor/commands'].map((name, index) => ({ id: `workspace-${['rules', 'commands'][index]}`, name, path: join(cwd, name), scope: 'workspace' as const, readOnly: false, kind: 'directory' as const, format: 'markdown' })),
    ...['.cursor/mcp.json', '.cursor/cli.json', 'AGENTS.md', 'CLAUDE.md'].map((name, index) => ({ id: `workspace-config-${index}`, name, path: join(cwd, name), scope: 'workspace' as const, readOnly: false, kind: 'file' as const, format: name.endsWith('.json') ? 'json' : 'markdown' })),
  ] }
}
