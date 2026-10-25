import { join } from 'node:path'
import type { AgentManagementAdapter } from '@ekko-studio/plugin-sdk'
import { directories, initializeScopedResources } from './configuration'
export const locations: NonNullable<AgentManagementAdapter['locations']> = async ({ config, mode }, context) => {
  const { home, source } = directories(config, context), native = mode === 'global' ? source : await initializeScopedResources(config, context), cwd = String(config.cwd)
  return { skills: [
    { id: 'native-skills', name: 'Grok skills', path: join(native, 'skills'), scope: mode, readOnly: false },
    { id: 'shared-skills', name: 'Shared skills', path: join(home, '.agents/skills'), scope: 'shared', readOnly: true },
    { id: 'project-skills', name: 'Grok project skills', path: join(cwd, '.grok/skills'), scope: 'workspace', readOnly: false },
    { id: 'shared-project-skills', name: 'Shared project skills', path: join(cwd, '.agents/skills'), scope: 'workspace', readOnly: false },
  ], configs: [
    ...(mode === 'global' ? [{ id: 'native-auth', name: 'auth.json', path: join(source, 'auth.json'), scope: 'global' as const, readOnly: false, kind: 'file' as const, format: 'json' }] : []),
    ...['config.toml', 'AGENTS.md'].map((name, index) => ({ id: `native-${index}`, name, path: join(native, name), scope: mode, readOnly: false, kind: 'file' as const, format: index === 0 ? 'toml' : 'markdown' })),
    ...['.grok/config.toml', 'AGENTS.md'].map((name, index) => ({ id: `project-${index}`, name, path: join(cwd, name), scope: 'workspace' as const, readOnly: false, kind: 'file' as const, format: index === 0 ? 'toml' : 'markdown' })),
  ] }
}
