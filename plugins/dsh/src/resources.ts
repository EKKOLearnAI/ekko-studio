import { join } from 'node:path'
import type { AgentManagementAdapter } from '@ekko-studio/plugin-sdk'
import { dshDirectories } from './configuration'

export const locations: NonNullable<AgentManagementAdapter['locations']> = async (input, runtime) => {
  const { sourceHome, home } = dshDirectories(input.config, runtime), cwd = String(input.config.cwd)
  return { skills: [
    { id: 'native-skills', name: 'DSH skills', path: join(sourceHome, 'skills'), scope: 'global', readOnly: false },
    { id: 'shared-skills', name: 'Shared skills', path: join(home, '.agents', 'skills'), scope: 'shared', readOnly: true },
  ], configs: [
    { id: 'native-settings', name: 'settings.yaml', path: join(sourceHome, 'settings.yaml'), scope: 'global', kind: 'file', format: 'yaml', readOnly: false },
    { id: 'native-instructions', name: 'AGENTS.md', path: join(sourceHome, 'AGENTS.md'), scope: 'global', kind: 'file', format: 'markdown', readOnly: false },
    { id: 'native-mcp', name: 'cordis.patch.yml', path: join(sourceHome, 'cordis.patch.yml'), scope: 'global', kind: 'file', format: 'yaml', readOnly: false },
    { id: 'native-web-profile', name: 'Web profile composition', path: join(sourceHome, 'profiles', 'web', 'cordis.patch.yml'), scope: 'global', kind: 'file', format: 'yaml', readOnly: false },
    { id: 'native-web-manifest', name: 'Web profile packages', path: join(sourceHome, 'profiles', 'web', 'package.json'), scope: 'global', kind: 'file', format: 'json', readOnly: true },
    { id: 'workspace-instructions', name: 'Workspace AGENTS.md', path: join(cwd, 'AGENTS.md'), scope: 'workspace', kind: 'file', format: 'markdown', readOnly: false },
  ] }
}
