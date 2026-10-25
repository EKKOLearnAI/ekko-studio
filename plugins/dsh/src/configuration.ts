import { homedir } from 'node:os'
import { access } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { StudioError, nativeAgentLaunch, type AgentRuntimeContext, type JsonObject } from '@ekko-studio/plugin-sdk'

export function dshDirectories(config: JsonObject, runtime: Pick<AgentRuntimeContext, 'stateDirectory'>) {
  const env = (config.env || {}) as Record<string, string>
  const home = env.HOME || env.USERPROFILE || homedir()
  const sourceHome = env.DSH_HOME || join(env.HERMES_CODING_AGENT_GLOBAL_HOME || home, '.dsh')
  if (![home, sourceHome, String(config.cwd)].every(isAbsolute)) throw new StudioError('INVALID_ARGUMENT', 'DSH resource directories must be absolute')
  return { home, sourceHome, rootDir: runtime.stateDirectory && join(runtime.stateDirectory, 'dsh'), sharedSkills: join(home, '.agents', 'skills') }
}

/** Resolve the executable/package path without executing DSH or reading native accounts. */
export async function installationCommand(config: JsonObject, runtime: Pick<AgentRuntimeContext, 'nativeCli'>) {
  const launch = nativeAgentLaunch('dsh', config, runtime)
  if (launch.args[0] && isAbsolute(launch.args[0]) && /(?:^|[/\\])(?:node|node\.exe|Electron)(?:$|[/\\])/i.test(launch.command)) return launch.args[0]
  if (isAbsolute(launch.command)) return launch.command
  const env = (config.env || {}) as Record<string, string>
  for (const directory of (env.PATH || process.env.PATH || '').split(delimiter)) {
    if (!isAbsolute(directory)) continue
    for (const suffix of process.platform === 'win32' ? ['', '.cmd', '.exe'] : ['']) {
      const candidate = join(directory, launch.command + suffix)
      try { await access(candidate); return candidate } catch { /* Continue the configured native search path. */ }
    }
  }
  throw new StudioError('RUNTIME_UNAVAILABLE', 'DSH executable is not installed')
}
