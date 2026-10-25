import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { StudioError, type AgentManagementAdapter } from '@ekko-studio/plugin-sdk'

export const locations: NonNullable<AgentManagementAdapter['locations']> = async ({ config, mode }, context) => {
  const env = (config.env || {}) as Record<string, string>, cwd = String(config.cwd)
  const home = mode === 'scoped' ? context.stateDirectory && join(context.stateDirectory, 'home') : env.HOME || env.USERPROFILE || homedir()
  const root = mode === 'scoped' ? context.stateDirectory && join(context.stateDirectory, 'copilot') : env.COPILOT_HOME || join(home!, '.copilot')
  if (!home || !root) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Scoped resources require host-managed storage')
  if (![cwd, home, root].every(isAbsolute)) throw new StudioError('INVALID_ARGUMENT', 'Copilot resource directories must be absolute')
  return { skills: [
    { id: 'native-skills', name: 'Copilot skills', path: join(root, 'skills'), scope: mode, readOnly: false },
    { id: 'shared-skills', name: 'Shared skills', path: join(home, '.agents', 'skills'), scope: 'shared', readOnly: true },
    { id: 'workspace-skills', name: 'Copilot workspace skills', path: join(cwd, '.github', 'skills'), scope: 'workspace', readOnly: false },
    { id: 'workspace-shared-skills', name: 'Workspace shared skills', path: join(cwd, '.agents', 'skills'), scope: 'workspace', readOnly: false },
  ], configs: [
    { id: 'native-config', name: 'Copilot settings', path: join(root, 'settings.json'), scope: mode, readOnly: false, kind: 'file', format: 'json' },
    { id: 'native-legacy-config', name: 'Copilot legacy configuration', path: join(root, 'config.json'), scope: mode, readOnly: false, kind: 'file', format: 'json' },
    { id: 'native-providers', name: 'Copilot providers', path: join(root, 'providers.json'), scope: mode, readOnly: false, kind: 'file', format: 'json' },
    { id: 'native-mcp', name: 'Copilot MCP', path: join(root, 'mcp-config.json'), scope: mode, readOnly: false, kind: 'file', format: 'json' },
    { id: 'native-instructions', name: 'Copilot instructions', path: join(root, 'copilot-instructions.md'), scope: mode, readOnly: false, kind: 'file', format: 'markdown' },
    { id: 'workspace-mcp', name: 'Copilot workspace MCP', path: join(cwd, '.mcp.json'), scope: 'workspace', readOnly: false, kind: 'file', format: 'json' },
    { id: 'workspace-github-mcp', name: 'Copilot repository MCP', path: join(cwd, '.github', 'mcp.json'), scope: 'workspace', readOnly: false, kind: 'file', format: 'json' },
    { id: 'workspace-instructions', name: 'Copilot repository instructions', path: join(cwd, '.github', 'copilot-instructions.md'), scope: 'workspace', readOnly: false, kind: 'file', format: 'markdown' },
    { id: 'workspace-agents', name: 'AGENTS.md', path: join(cwd, 'AGENTS.md'), scope: 'workspace', readOnly: false, kind: 'file', format: 'markdown' },
  ] }
}
