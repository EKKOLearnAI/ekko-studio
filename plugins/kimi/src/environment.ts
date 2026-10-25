import { existsSync } from 'node:fs'
import { win32 } from 'node:path'
import { StudioError, type AgentRuntimeContext, type JsonObject } from '@ekko-studio/plugin-sdk'

/** Kimi requires native Git Bash on Windows; WSL launchers cannot supply this runtime. */
export async function kimiEnvironment(config: JsonObject, context: AgentRuntimeContext, platform = process.platform, signal = context.signal): Promise<Record<string, string>> {
  if (platform !== 'win32') return {}
  const env = config.env as Record<string, string> || {}, custom = env.KIMI_SHELL_PATH?.trim().replace(/^"(.*)"$/, '$1')
  const roots = [env.ProgramFiles || process.env.ProgramFiles || 'C:\\Program Files', env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Programs')].filter((value): value is string => !!value)
  const candidates = custom ? [custom] : [...roots.flatMap(root => ['bin', 'usr\\bin'].map(dir => win32.join(root, 'Git', dir, 'bash.exe'))),
    ...(env.PATH || process.env.PATH || '').split(';').slice(0, 128).filter(Boolean).map(dir => win32.join(dir, 'bash.exe'))]
  for (const candidate of new Set(candidates.map(path => win32.normalize(path)))) {
    if (!win32.isAbsolute(candidate) || /\\(?:System32|WindowsApps)\\/i.test(candidate) || !existsSync(candidate)) continue
    let processHandle: import('@ekko-studio/plugin-sdk').ProcessHandle | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let rejectAbort!: (error: unknown) => void
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject })
    void aborted.catch(() => {})
    const abort = () => rejectAbort(signal.reason || new StudioError('CANCELLED', 'Kimi environment check cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    try {
      if (signal.aborted) throw signal.reason
      processHandle = await context.processes.spawn({ command: candidate, args: ['--version'], cwd: String(config.cwd) })
      timer = setTimeout(() => rejectAbort(new StudioError('DEADLINE_EXCEEDED', 'Git Bash version probe timed out')), 5000)
      let output = '', bytes = 0
      while (true) {
        if (signal.aborted) throw signal.reason
        const batch = await Promise.race([processHandle.read(), aborted])
        for (const chunk of batch.chunks) { bytes += chunk.data.length; output += Buffer.from(chunk.data).toString() }
        if (bytes > 16384 || batch.truncated) break
        if (batch.exit && !batch.chunks.length) {
          if (batch.exit.code === 0 && /GNU bash/i.test(output)) return { KIMI_SHELL_PATH: candidate }
          break
        }
      }
    } catch (error) { if (signal.aborted || context.signal.aborted) throw error }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); await processHandle?.dispose() }
  }
  throw new StudioError('CAPABILITY_UNSUPPORTED', 'Kimi Code on Windows requires Git Bash; configure KIMI_SHELL_PATH with its absolute bash.exe path')
}
