import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const STUDIO_MANAGED_MCP_ENV = 'HERMES_WEB_UI_MANAGED_MCP'
export interface ManagedMcpLaunch {
  command: string
  args: string[]
  env: Record<string, string>
}

function bundledLauncher(): string | undefined {
  const candidates = [process.env.HERMES_WEB_UI_MCP_BIN]
  for (const name of ['ekko-studio-mcp.mjs', 'hermes-web-ui-mcp.mjs']) {
    candidates.push(join(process.cwd(), 'bin', name))
    // Bundled server, older source layouts, and this source module respectively.
    for (const levels of [2, 3, 5, 6, 7]) candidates.push(join(__dirname, '../'.repeat(levels), 'bin', name))
  }
  return candidates.find((candidate): candidate is string => !!candidate && existsSync(candidate))
}

/** Platform launch policy; vendor adapters only translate this DTO to native config formats. */
export function studioManagedMcpConfig(profile: string, serverName: string, toolset: string, host: {
  appHome: string; port: number | string; nativeTaskPlan?: boolean; runTokenFile?: string
}): ManagedMcpLaunch {
  const launcher = bundledLauncher()
  return {
    command: launcher ? process.env.HERMES_AGENT_NODE?.trim() || process.execPath : 'ekko-studio-mcp',
    args: launcher ? [launcher, toolset] : [toolset],
    env: {
      HERMES_WEB_UI_URL: `http://127.0.0.1:${host.port}`,
      HERMES_WEB_UI_HOME: host.appHome,
      HERMES_WEBUI_STATE_DIR: host.appHome,
      HERMES_WEB_UI_PROFILE: profile,
      HERMES_MCP_SERVER_NAME: serverName,
      HERMES_MCP_TOOLSET: toolset,
      [STUDIO_MANAGED_MCP_ENV]: '1',
      ...(host.nativeTaskPlan ? { HERMES_MCP_NATIVE_TASK_PLAN: '1' } : { HERMES_MCP_USER_CLARIFICATION: '1' }),
      ...(host.runTokenFile ? { HERMES_WEB_UI_RUN_TOKEN_FILE: host.runTokenFile } : {}),
      // Never inherit static bearer tokens or an Electron GUI launch mode.
      HERMES_WEB_UI_TOKEN: '', AUTH_TOKEN: '', ELECTRON_RUN_AS_NODE: '1',
    },
  }
}
