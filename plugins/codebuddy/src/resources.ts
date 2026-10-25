import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { StudioError, type AgentManagementAdapter } from '@ekko-studio/plugin-sdk'

export const locations: NonNullable<AgentManagementAdapter['locations']> = async ({ config, mode }, context) => {
  const env = (config.env || {}) as Record<string, string>, cwd = String(config.cwd)
  const home = mode === 'scoped' ? context.stateDirectory && join(context.stateDirectory, 'home') : env.HOME || env.USERPROFILE || homedir()
  const root = mode === 'scoped' ? context.stateDirectory && join(context.stateDirectory, 'codebuddy') : env.CODEBUDDY_CONFIG_DIR || join(home!, '.codebuddy')
  if (!home || !root) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Scoped resources require host-managed storage')
  if (![cwd, home, root].every(isAbsolute)) throw new StudioError('INVALID_ARGUMENT', 'CodeBuddy resource directories must be absolute')
  return { skills: [
    { id: 'native-skills', name: 'CodeBuddy skills', path: join(root, 'skills'), scope: mode, readOnly: false },
    { id: 'workspace-skills', name: 'CodeBuddy workspace skills', path: join(cwd, '.codebuddy', 'skills'), scope: 'workspace', readOnly: false },
  ], configs: [
    { id: 'native-config', name: 'CodeBuddy settings', path: join(root, 'settings.json'), scope: mode, readOnly: false, kind: 'file', format: 'json' },
    { id: 'native-models', name: 'CodeBuddy models', path: join(root, 'models.json'), scope: mode, readOnly: false, kind: 'file', format: 'json' },
    { id: 'native-mcp', name: 'CodeBuddy MCP', path: join(root, '.mcp.json'), scope: mode, readOnly: false, kind: 'file', format: 'json' },
    { id: 'native-mcp-legacy', name: 'CodeBuddy legacy MCP', path: join(root, 'mcp.json'), scope: mode, readOnly: false, kind: 'file', format: 'json' },
    { id: 'native-instructions', name: 'CODEBUDDY.md', path: join(root, 'CODEBUDDY.md'), scope: mode, readOnly: false, kind: 'file', format: 'markdown' },
    { id: 'workspace-config', name: 'CodeBuddy project settings', path: join(cwd, '.codebuddy', 'settings.json'), scope: 'workspace', readOnly: false, kind: 'file', format: 'json' },
    { id: 'workspace-models', name: 'CodeBuddy project models', path: join(cwd, '.codebuddy', 'models.json'), scope: 'workspace', readOnly: false, kind: 'file', format: 'json' },
    { id: 'workspace-mcp', name: 'CodeBuddy project MCP', path: join(cwd, '.mcp.json'), scope: 'workspace', readOnly: false, kind: 'file', format: 'json' },
    { id: 'workspace-mcp-legacy', name: 'CodeBuddy legacy project MCP', path: join(cwd, 'mcp.json'), scope: 'workspace', readOnly: false, kind: 'file', format: 'json' },
    { id: 'workspace-instructions', name: 'CODEBUDDY.md', path: join(cwd, 'CODEBUDDY.md'), scope: 'workspace', readOnly: false, kind: 'file', format: 'markdown' },
    { id: 'workspace-config-instructions', name: 'CodeBuddy project memory', path: join(cwd, '.codebuddy', 'CODEBUDDY.md'), scope: 'workspace', readOnly: false, kind: 'file', format: 'markdown' },
  ] }
}
