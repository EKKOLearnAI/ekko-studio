import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { windowsCommandNeedsShell } from '../../../studio/public/windows-command'

export function findZcodeDesktopCli(env: NodeJS.ProcessEnv): string | undefined {
  let resources: string[] = []
  if (process.platform === 'darwin') {
    resources = ['/Applications', posix.join(homedir(), 'Applications')]
      .map(directory => posix.join(directory, 'ZCode.app', 'Contents', 'Resources'))
  } else if (process.platform === 'win32') {
    resources = [
      env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Programs', 'ZCode', 'resources'),
      env.ProgramFiles && win32.join(env.ProgramFiles, 'ZCode', 'resources'),
      env['ProgramFiles(x86)'] && win32.join(env['ProgramFiles(x86)'], 'ZCode', 'resources'),
    ].filter((path): path is string => Boolean(path))
  } else if (process.platform === 'linux') {
    resources = ['/opt/ZCode/resources', '/opt/zcode/resources']
  }
  const path = process.platform === 'win32' ? win32 : posix
  return resources.map(directory => path.join(directory, 'glm', 'zcode.cjs')).find(existsSync)
}

export async function resolveZcodeCommand(
  args: string[],
  env: NodeJS.ProcessEnv,
  findCommandPaths: (command: string, env: NodeJS.ProcessEnv) => Promise<string[]>,
  options: { preferDesktop?: boolean } = {},
): Promise<{ command: string; args: string[]; env: Record<string, string>; path: string }> {
  const candidates = await findCommandPaths('zcode', env)
  const cli = (process.platform === 'win32' && candidates.find(windowsCommandNeedsShell)) || candidates[0]
  const preferredDesktop = options.preferDesktop ? findZcodeDesktopCli(env) : undefined
  if (cli && !preferredDesktop) return { command: cli, args, env: {}, path: cli }

  const bundledCli = preferredDesktop || findZcodeDesktopCli(env)
  if (!bundledCli) return { command: 'zcode', args, env: {}, path: 'zcode' }

  const path = process.platform === 'win32' ? win32 : posix
  const resources = path.dirname(path.dirname(bundledCli))
  const builtin = path.join(resources, 'config', 'provider', 'zcode-builtin.json')
  const personal = path.join(env.ZCODE_DATA_BASE_DIR?.trim() || homedir(), '.zcode', 'v2', 'provider_config.json')
  // Studio's server already has a Node runtime, including Electron's Node mode.
  // The desktop bundle keeps provider assets outside glm/, where the CLI searches.
  // Supplying both paths also avoids writing refresh files into the app bundle.
  return { command: process.execPath, args: [bundledCli, ...args],
    env: { ELECTRON_RUN_AS_NODE: '1',
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim() || builtin,
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim() || personal,
      ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: env.ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE ?? '',
    }, path: bundledCli }
}
