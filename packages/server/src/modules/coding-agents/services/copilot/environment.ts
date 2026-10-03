import { win32 } from 'node:path'
import { codingAgentEnvironmentError, type CodingAgentEnvironment } from '../../contracts/environment'

export async function checkCopilotEnvironment(context: CodingAgentEnvironment): Promise<Record<string, string>> {
  if (context.platform !== 'win32') return {}
  const candidates = await context.findCommandPaths('pwsh.exe', context.env)
  // MSI installs may not be on the desktop app's inherited PATH yet.
  if (context.env.ProgramFiles) candidates.push(...['7', '6'].map(version => win32.join(context.env.ProgramFiles!, 'PowerShell', version, 'pwsh.exe')))
  for (const candidate of new Set(candidates)) {
    try {
      const version = await context.output(candidate, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'])
      const major = Number(version.trim().match(/^(\d+)\./)?.[1] || 0)
      if (major >= 6) {
        // Node keeps the first lexicographic key when Windows env contains both PATH and Path.
        const pathKey = Object.keys(context.env).sort().find(key => key.toLowerCase() === 'path') || 'PATH'
        return { [pathKey]: [win32.dirname(candidate), context.env[pathKey]].filter(Boolean).join(';') }
      }
    } catch { /* A missing or broken PowerShell is not a usable prerequisite. */ }
  }
  throw codingAgentEnvironmentError('GitHub Copilot on Windows requires PowerShell 6 or later (pwsh.exe). Install PowerShell and restart Studio, or add its directory to PATH. Windows PowerShell 5.1 is insufficient.')
}
