import { win32 } from 'node:path'
import { codingAgentEnvironmentError, type CodingAgentEnvironment } from '../../contracts/environment'

export async function checkKimiEnvironment(context: CodingAgentEnvironment): Promise<Record<string, string>> {
  if (context.platform !== 'win32') return {}
  const custom = context.env.KIMI_SHELL_PATH?.trim().replace(/^"(.*)"$/, '$1')
  const roots = [context.env.ProgramFiles, context.env['ProgramFiles(x86)'],
    context.env.LOCALAPPDATA && win32.join(context.env.LOCALAPPDATA, 'Programs')].filter((value): value is string => Boolean(value))
  const candidates = custom ? [custom] : [
    ...roots.flatMap(root => ['bin', 'usr\\bin'].map(dir => win32.join(root, 'Git', dir, 'bash.exe'))),
    ...await context.findCommandPaths('bash.exe', context.env),
  ]
  for (const candidate of new Set(candidates.map(path => win32.normalize(path)))) {
    // Windows' WSL launcher is not a native Git Bash runtime.
    if (!win32.isAbsolute(candidate) || /\\(?:System32|WindowsApps)\\/i.test(candidate) || !context.exists(candidate)) continue
    try {
      if (/GNU bash/i.test(await context.output(candidate, ['--version']))) return { KIMI_SHELL_PATH: candidate }
    } catch { /* Try the next installed Git Bash. */ }
  }
  throw codingAgentEnvironmentError(custom
    ? `Kimi Code cannot run KIMI_SHELL_PATH (${custom}). Set it to the absolute path of a working Git for Windows bash.exe.`
    : 'Kimi Code on Windows requires Git for Windows. Install Git Bash, or set KIMI_SHELL_PATH to its bash.exe absolute path.')
}
