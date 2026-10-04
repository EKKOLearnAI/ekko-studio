import { spawn, type ChildProcess } from 'child_process'
import { StringDecoder } from 'node:string_decoder'
import type { CodingAgentImageInput } from '../../protocol/types'
import { normalizeWindowsCommandPath, windowsCmdShimExecution, windowsCommandNeedsShell } from '../../../studio/public/windows-command'
import { createAntigravityStreamParser, type AntigravityEvent } from './stream-json'

export const ANTIGRAVITY_COMPACT_UNSUPPORTED = 'Native /compact is not supported for antigravity'

export interface AntigravityTurnProcessInput {
  command: string
  baseArgs: string[]
  workspaceDir: string
  env: NodeJS.ProcessEnv
  nativeSessionId: string
  resume: boolean
  input: string
  images: CodingAgentImageInput[]
  onEvent: (event: AntigravityEvent) => void
  onStderr: (chunk: Buffer) => void
  onError: (error: Error) => void
  onClose: (code: number | null) => void
}

function antigravityPrompt(input: string, images: CodingAgentImageInput[]): string {
  const text = String(input || '').trim()
  if (!images.length) return text
  // Headless NDJSON supports only text. Its native view_file tool supplies
  // image bytes to the model; do not fabricate unsupported image blocks.
  return [text, 'Before answering, open each attached image with the native image/file viewing tool and inspect its visual content:',
    ...images.map(image => JSON.stringify(image.path))].filter(Boolean).join('\n')
}

export function buildAntigravityTurnArgs(
  baseArgs: string[],
  nativeSessionId: string,
  resume: boolean,
  _prompt: string,
): string[] {
  const resumeArgs = resume && String(nativeSessionId || '').trim()
    ? ['--conversation', String(nativeSessionId).trim()]
    : []
  return [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    ...resumeArgs,
    '--dangerously-skip-permissions',
    ...baseArgs.filter(arg => arg !== '--dangerously-skip-permissions'),
    '--print-timeout', '0',
  ]
}

export function createAntigravityStdoutReader(): { push(chunk: Buffer): string[]; end(): string[] } {
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  const takeLines = (flush: boolean): string[] => {
    const lines = buffer.split(/\r?\n/)
    buffer = flush ? '' : lines.pop() || ''
    return lines.filter(line => line.length > 0)
  }
  return {
    push(chunk: Buffer) {
      buffer += decoder.write(chunk)
      return takeLines(false)
    },
    end() {
      buffer += decoder.end()
      return takeLines(true)
    },
  }
}

function spawnAntigravity(command: string, args: string[], input: AntigravityTurnProcessInput): ChildProcess {
  const normalizedCommand = process.platform === 'win32' ? normalizeWindowsCommandPath(command) : command
  if (process.platform === 'win32' && windowsCommandNeedsShell(command)) {
    const execution = windowsCmdShimExecution(normalizedCommand, args)
    return spawn(execution.command, execution.args, {
      cwd: input.workspaceDir,
      env: input.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: execution.windowsVerbatimArguments,
    })
  }
  return spawn(normalizedCommand, args, {
    cwd: input.workspaceDir,
    env: input.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // The shared stop path signals -pid to terminate the CLI and its tools.
    detached: process.platform !== 'win32',
    windowsHide: true,
  })
}

export function startAntigravityTurnProcess(input: AntigravityTurnProcessInput): ChildProcess {
  const prompt = antigravityPrompt(input.input, input.images)
  const args = buildAntigravityTurnArgs(input.baseArgs, input.nativeSessionId, input.resume, prompt)
  const child = spawnAntigravity(input.command, args, input)
  child.stdin?.on('error', () => { /* startup/close handlers own lifecycle errors */ })
  // Stream-json explicitly activates headless mode without the value-taking
  // -p flag. Send one turn and EOF; model-step usage belongs to this input.
  child.stdin?.end(`${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`)
  const stdout = createAntigravityStdoutReader()
  const parse = createAntigravityStreamParser({ resumed: input.resume })
  child.stdout?.on('data', (chunk: Buffer) => {
    for (const line of stdout.push(chunk)) {
      for (const event of parse(line)) input.onEvent(event)
    }
  })
  child.stderr?.on('data', input.onStderr)
  child.on('error', input.onError)
  child.on('close', (code) => {
    for (const line of stdout.end()) {
      for (const event of parse(line)) input.onEvent(event)
    }
    input.onClose(code)
  })
  return child
}
