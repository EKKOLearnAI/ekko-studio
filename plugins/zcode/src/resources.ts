import { join } from 'node:path'
import type { AgentManagementAdapter } from '@ekko-studio/plugin-sdk'
import { directories, launchZcode } from './environment'

export const locations: NonNullable<AgentManagementAdapter['locations']> = async ({ config, mode }, context) => {
  const { home, personal } = directories(config, mode, context), cwd = String(config.cwd), builtin = launchZcode(config, context).env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE
  return { skills: [
    { id: 'native-skills', name: 'ZCode skills', path: join(home, '.zcode', 'skills'), scope: mode, readOnly: false },
    { id: 'shared-skills', name: 'Shared skills', path: join(home, '.agents', 'skills'), scope: 'shared', readOnly: true },
    { id: 'workspace-skills', name: 'ZCode project skills', path: join(cwd, '.zcode', 'skills'), scope: 'workspace', readOnly: false },
    { id: 'workspace-shared-skills', name: 'Shared project skills', path: join(cwd, '.agents', 'skills'), scope: 'workspace', readOnly: false },
  ], configs: [
    { id: 'native-config', name: 'config.json', path: join(home, '.zcode', 'cli', 'config.json'), scope: mode, readOnly: false, kind: 'file', format: 'json' },
    ...(mode === 'global' ? [{ id: 'native-providers', name: 'provider_config.json', path: personal, scope: mode, readOnly: false, kind: 'file' as const, format: 'json' }] : []),
    ...(mode === 'global' && builtin ? [{ id: 'native-builtin', name: 'Builtin providers', path: builtin, scope: mode, readOnly: true, kind: 'file' as const, format: 'json' }] : []),
    { id: 'native-instructions', name: 'AGENTS.md', path: join(home, '.zcode', 'AGENTS.md'), scope: mode, readOnly: false, kind: 'file', format: 'markdown' },
    ...['AGENTS.md', 'zcode.json', '.zcode/config.json'].map((name, index) => ({ id: `workspace-config-${index}`, name, path: join(cwd, name), scope: 'workspace' as const, readOnly: false, kind: 'file' as const, format: name.endsWith('.json') ? 'json' : 'markdown' })),
  ] }
}
