import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../../../studio/public/config'
import { logger } from '../../../studio/public/logging'
import { buildWindowsCmdShimArgs } from '../../../studio/public/windows-command'

/** ZCode's -p is argv-only. Keep large/multiline Windows input out of cmd.exe. */
export function prepareZcodePrompt(command: string, args: string[], text: string): {
  args: string[]; cleanup(): void
} {
  const directArgs = [...args, '-p', text]
  const needsFile = process.platform === 'win32'
    ? /[\r\n]/.test(text) || buildWindowsCmdShimArgs(command, directArgs).join(' ').length > 7000
    : Buffer.byteLength(text, 'utf8') > 64 * 1024
  if (!needsFile) return { args: directArgs, cleanup() {} }
  const parent = join(config.appHome, 'coding-agent', 'inputs')
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const root = mkdtempSync(join(parent, 'zcode-'))
  const path = join(root, 'prompt.txt')
  const cleanup = () => {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) }
    catch (error) { logger.warn({ err: error, root }, '[coding-agent-input] failed to remove ZCode prompt file') }
  }
  try {
    writeFileSync(path, text, { encoding: 'utf8', mode: 0o600 })
    // The native attachment preview may truncate large text. Explicitly require
    // reading to EOF so instructions beyond that preview are not lost.
    const prompt = `The attached UTF-8 file ${JSON.stringify(path)} contains the complete instructions and user request for this turn. Read the entire file to EOF, using additional reads if a preview is truncated, then carry out that request. Do not summarize the file instead of executing its instructions.`
    return { args: [...args, '--attach', path, '-p', prompt], cleanup }
  } catch (error) { cleanup(); throw error }
}
