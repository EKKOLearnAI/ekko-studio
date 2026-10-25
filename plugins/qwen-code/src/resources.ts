import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { StudioError, type AgentManagementAdapter } from '@ekko-studio/plugin-sdk'

/** Only locations cross the plugin boundary. Studio owns all file operations. */
export const locations: NonNullable<AgentManagementAdapter['locations']> = async (input, context) => {
  const env = (input.config.env || {}) as Record<string, string>, cwd = String(input.config.cwd)
  const home = input.mode === 'scoped' ? context.stateDirectory && join(context.stateDirectory, 'home') : env.HOME || env.USERPROFILE || homedir()
  const root = input.mode === 'scoped' ? context.stateDirectory && join(context.stateDirectory, 'qwen') : env.QWEN_HOME || join(home!, '.qwen')
  if (!root || !home) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Scoped resources require host-managed storage')
  if (![root, home, cwd].every(isAbsolute)) throw new StudioError('INVALID_ARGUMENT', 'Native resource directories must be absolute')
  return {
    skills: [
      { id: 'native-skills', name: 'Agent skills', path: join(root, 'skills'), scope: input.mode, readOnly: false },
      { id: 'shared-skills', name: 'Shared skills', path: join(home, '.agents', 'skills'), scope: 'shared', readOnly: true },
      { id: 'workspace-skills', name: 'Workspace skills', path: join(cwd, '.agents', 'skills'), scope: 'workspace', readOnly: false },
      { id: 'workspace-qwen-skills', name: 'Qwen workspace skills', path: join(cwd, '.qwen', 'skills'), scope: 'workspace', readOnly: false },
    ],
    configs: [
      { id: 'native-config', name: 'settings.json', path: join(root, 'settings.json'), scope: input.mode, readOnly: false, kind: 'file', format: 'json' },
      { id: 'native-instructions', name: 'QWEN.md', path: join(root, 'QWEN.md'), scope: input.mode, readOnly: false, kind: 'file', format: 'markdown' },
      { id: 'workspace-instructions', name: 'QWEN.md', path: join(cwd, 'QWEN.md'), scope: 'workspace', readOnly: false, kind: 'file', format: 'markdown' },
    ],
  }
}
