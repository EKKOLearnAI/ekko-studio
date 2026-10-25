import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { StudioError, type AgentManagementAdapter } from '@ekko-studio/plugin-sdk'

/** Only locations cross the plugin boundary. Studio owns all file operations. */
export const locations: NonNullable<AgentManagementAdapter['locations']> = async (input, context) => {
  const env = (input.config.env || {}) as Record<string, string>, cwd = String(input.config.cwd)
  const home = input.mode === 'scoped' ? context.stateDirectory && join(context.stateDirectory, 'home') : env.HOME || env.USERPROFILE || homedir()
  const root = input.mode === 'scoped' ? context.stateDirectory && join(context.stateDirectory, 'codex') : env.CODEX_HOME || join(home!, '.codex')
  if (!root || !home) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Scoped resources require host-managed storage')
  if (![root, home, cwd].every(isAbsolute)) throw new StudioError('INVALID_ARGUMENT', 'Native resource directories must be absolute')
  return {
    skills: [
      { id: 'native-skills', name: 'Agent skills', path: join(root, 'skills'), scope: input.mode, readOnly: false },
      { id: 'shared-skills', name: 'Shared skills', path: join(home, '.agents', 'skills'), scope: 'shared', readOnly: true },
      { id: 'workspace-skills', name: 'Workspace skills', path: join(cwd, '.agents', 'skills'), scope: 'workspace', readOnly: false },
      { id: 'builtin-skills', name: 'Codex built-in skills', path: join(root, 'skills', '.system'), scope: 'builtin', readOnly: true },
    ],
    configs: [
      { id: 'native-config', name: 'config.toml', path: join(root, 'config.toml'), scope: input.mode, readOnly: false, kind: 'file', format: 'toml' },
      { id: 'native-instructions', name: 'AGENTS.md', path: join(root, 'AGENTS.md'), scope: input.mode, readOnly: false, kind: 'file', format: 'markdown' },
      { id: 'workspace-instructions', name: 'AGENTS.md', path: join(cwd, 'AGENTS.md'), scope: 'workspace', readOnly: false, kind: 'file', format: 'markdown' },
    ],
  }
}
