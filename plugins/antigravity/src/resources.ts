import { join } from 'node:path'
import { type AgentManagementAdapter } from '@ekko-studio/plugin-sdk'
import { sourceHome } from './configuration'
export const locations: NonNullable<AgentManagementAdapter['locations']> = async ({ config, mode }, runtime) => {
  const home = sourceHome(config, mode, runtime),
    root = join(home, '.gemini')
  return {
    skills: [
      { id: 'native-skills', name: 'Antigravity skills', path: join(root, 'config', 'skills'), scope: mode, readOnly: false },
      { id: 'shared-skills', name: 'Shared skills', path: join(home, '.agents', 'skills'), scope: 'shared', readOnly: true },
    ],
    configs: [
      {
        id: 'native-settings',
        name: 'Antigravity settings',
        path: join(root, 'antigravity-cli', 'settings.json'),
        scope: mode,
        readOnly: false,
        kind: 'file',
        format: 'json',
      },
      {
        id: 'native-mcp',
        name: 'Antigravity MCP',
        path: join(root, 'config', 'mcp_config.json'),
        scope: mode,
        readOnly: false,
        kind: 'file',
        format: 'json',
      },
      {
        id: 'native-instructions',
        name: 'Antigravity instructions',
        path: join(root, 'config', 'AGENTS.md'),
        scope: mode,
        readOnly: false,
        kind: 'file',
        format: 'markdown',
      },
    ],
  }
}
