import { existsSync } from 'node:fs'
import { win32 } from 'node:path'
import { StudioError, type AgentRuntimeContext, type JsonObject, type ProcessHandle } from '@ekko-studio/plugin-sdk'

export async function copilotEnvironment(config: JsonObject, context: AgentRuntimeContext, platform = process.platform, signal = context.signal): Promise<Record<string, string>> {
  if (platform !== 'win32') return {}
  const env = config.env as Record<string, string> || {}
  const lookup = (key: string) => Object.entries(env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1]
    ?? Object.entries(process.env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1]
  const path = lookup('PATH') || '', programFiles = lookup('ProgramFiles') || 'C:\\Program Files'
  const candidates = [...path.split(';').filter(Boolean).slice(0, 128).map(root => win32.join(root.replace(/^"(.*)"$/, '$1'), 'pwsh.exe')),
    ...['7', '6'].map(version => win32.join(programFiles, 'PowerShell', version, 'pwsh.exe'))]
  for (const candidate of new Set(candidates)) {
    if (!win32.isAbsolute(candidate) || !existsSync(candidate)) continue
    let handle: ProcessHandle | undefined, timer: ReturnType<typeof setTimeout> | undefined, rejectAbort!: (error: unknown) => void
    const ended = new Promise<never>((_, reject) => { rejectAbort = reject }); void ended.catch(() => {})
    const abort = () => rejectAbort(signal.reason || new StudioError('CANCELLED', 'Copilot environment check cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    try {
      if (signal.aborted) throw signal.reason
      handle = await context.processes.spawn({ command: candidate, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], cwd: String(config.cwd) })
      timer = setTimeout(() => rejectAbort(new StudioError('DEADLINE_EXCEEDED', 'PowerShell version probe timed out')), 5000)
      let output = '', bytes = 0
      while (true) {
        const batch = await Promise.race([handle.read(), ended])
        for (const chunk of batch.chunks) { bytes += chunk.data.length; if (chunk.stream === 'stdout') output += Buffer.from(chunk.data).toString() }
        if (bytes > 16384 || batch.truncated) break
        if (batch.exit && !batch.chunks.length) {
          if (batch.exit.code === 0 && Number(output.trim().match(/^(\d+)\./)?.[1] || 0) >= 6) return { PATH: [win32.dirname(candidate), path].filter(Boolean).join(';') }
          break
        }
      }
    } catch (error) { if (signal.aborted || context.signal.aborted) throw error }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); await handle?.dispose() }
  }
  throw new StudioError('CAPABILITY_UNSUPPORTED', 'GitHub Copilot on Windows requires PowerShell 6 or later (pwsh.exe); Windows PowerShell 5.1 is insufficient')
}
