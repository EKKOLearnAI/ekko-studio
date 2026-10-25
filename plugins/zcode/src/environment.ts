import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, posix, win32 } from 'node:path'
import { StudioError, nativeAgentLaunch, type AgentRuntimeContext, type JsonObject } from '@ekko-studio/plugin-sdk'

export const nativeVersion = '0.16.9'
export const docsUrl = 'https://github.com/zai-org/ZCode'

export function directories(config: JsonObject, mode: string, context: Pick<AgentRuntimeContext, 'stateDirectory'>) {
  const env = config.env as Record<string, string> || {}
  const home = mode === 'scoped' ? context.stateDirectory && join(context.stateDirectory, 'home') : env.HOME || env.USERPROFILE || homedir()
  if (!home || !isAbsolute(home)) throw new StudioError('INVALID_ARGUMENT', 'ZCode requires an absolute native home')
  const base = mode === 'scoped' ? home : env.ZCODE_DATA_BASE_DIR || home
  const storage = mode === 'scoped' ? context.stateDirectory && join(context.stateDirectory, 'native') : env.ZCODE_STORAGE_DIR || join(home, '.zcode')
  if (!storage || ![base, storage].every(isAbsolute)) throw new StudioError('INVALID_ARGUMENT', 'ZCode requires absolute native storage')
  return { home, base, storage, personal: mode === 'scoped' ? join(home, '.zcode', 'v2', 'provider_config.json')
    : env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE || join(base, '.zcode', 'v2', 'provider_config.json') }
}

export function launchZcode(config: JsonObject, context: Pick<AgentRuntimeContext, 'nativeCli'>) {
  const env = config.env as Record<string, string> || {}
  const names = process.platform === 'win32' ? ['zcode.cmd', 'zcode.bat', 'zcode.exe', 'zcode'] : ['zcode']
  const standalone = (env.PATH || process.env.PATH || '').split(delimiter).filter(Boolean).flatMap(directory => names.map(name => join(directory, name))).find(path => {
    try { accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return statSync(path).isFile() } catch { return false }
  })
  const roots = process.platform === 'darwin' ? ['/Applications/ZCode.app/Contents/Resources', join(env.HOME || homedir(), 'Applications/ZCode.app/Contents/Resources')]
    : process.platform === 'win32' ? [env.LOCALAPPDATA || process.env.LOCALAPPDATA, env.ProgramFiles || process.env.ProgramFiles, env['ProgramFiles(x86)'] || process.env['ProgramFiles(x86)']]
      .flatMap((root, index) => root ? [win32.join(root, ...(index === 0 ? ['Programs'] : []), 'ZCode', 'resources')] : [])
      : ['/opt/ZCode/resources', '/opt/zcode/resources']
  const desktop = roots.map(root => (process.platform === 'win32' ? win32 : posix).join(root, 'glm', 'zcode.cjs')).find(existsSync)
  const launch = config.command || context.nativeCli ? nativeAgentLaunch('zcode', config, context)
    : standalone ? { command: standalone, args: [...config.args as string[] || []] }
      : desktop ? { command: process.execPath, args: [desktop, ...(config.args as string[] || [])] } : nativeAgentLaunch('zcode', config, context)
  const entry = launch.args.find(arg => /(?:^|[/\\])zcode\.cjs$/i.test(arg))
  const resources = entry && dirname(dirname(entry))
  return { ...launch, env: { ...(resources ? {
    ELECTRON_RUN_AS_NODE: '1',
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE || join(resources, 'config', 'provider', 'zcode-builtin.json'),
    ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: env.ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE ?? '',
  } : {}), ...env } }
}
