import { spawn, type ChildProcess } from 'child_process'
import { StringDecoder } from 'node:string_decoder'
import type { CodingAgentImageInput } from '../../protocol/types'
import { normalizeWindowsCommandPath, windowsCmdShimExecution, windowsCommandNeedsShell } from '../../../studio/public/windows-command'
import { parseCursorStreamJsonLine, type CursorStreamEvent } from './stream-json'

export const CURSOR_COMPACT_UNSUPPORTED = 'Native /compact is not supported for cursor'

export interface CursorTurnProcessInput {
  command: string
  baseArgs: string[]
  workspaceDir: string
  env: NodeJS.ProcessEnv
  nativeSessionId: string
  resume: boolean
  input: string
  images: CodingAgentImageInput[]
  onEvent: (event: CursorStreamEvent) => void
  onStderr: (chunk: Buffer) => void
  onError: (error: Error) => void
  onClose: (code: number | null) => void
}

function cursorPrompt(input: string, images: CodingAgentImageInput[]): string {
  const text = String(input || '').trim()
  const imageNotes = images
    .map(image => String(image.path || '').trim())
    .filter(Boolean)
    .map(path => `Image: ${path}`)
  return [text, ...imageNotes].filter(Boolean).join('\n')
}

export function buildCursorTurnArgs(
  baseArgs: string[],
  nativeSessionId: string,
  resume: boolean,
  prompt: string,
): string[] {
  const resumeArgs = resume && String(nativeSessionId || '').trim()
    ? ['--resume', String(nativeSessionId).trim()]
    : []
  return [
    '-p',
    '--force',
    '--output-format',
    'stream-json',
    '--stream-partial-output',
    ...resumeArgs,
    ...baseArgs,
    prompt,
  ]
}

export function createCursorStdoutReader(): { push(chunk: Buffer): string[]; end(): string[] } {
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

function spawnCursor(command: string, args: string[], input: CursorTurnProcessInput): ChildProcess {
  const normalizedCommand = process.platform === 'win32' ? normalizeWindowsCommandPath(command) : command
  if (process.platform === 'win32' && windowsCommandNeedsShell(command)) {
    const execution = windowsCmdShimExecution(normalizedCommand, args)
    return spawn(execution.command, execution.args, {
      cwd: input.workspaceDir,
      env: input.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: execution.windowsVerbatimArguments,
    })
  }
  return spawn(normalizedCommand, args, {
    cwd: input.workspaceDir,
    env: input.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

export function startCursorTurnProcess(input: CursorTurnProcessInput): ChildProcess {
  const prompt = cursorPrompt(input.input, input.images)
  const args = buildCursorTurnArgs(input.baseArgs, input.nativeSessionId, input.resume, prompt)
  const child = spawnCursor(input.command, args, input)
  const stdout = createCursorStdoutReader()
  child.stdout?.on('data', (chunk: Buffer) => {
    for (const line of stdout.push(chunk)) {
      const event = parseCursorStreamJsonLine(line, { streamPartial: true })
      if (event) input.onEvent(event)
    }
  })
  child.stderr?.on('data', input.onStderr)
  child.on('error', input.onError)
  child.on('close', (code) => {
    for (const line of stdout.end()) {
      const event = parseCursorStreamJsonLine(line, { streamPartial: true })
      if (event) input.onEvent(event)
    }
    input.onClose(code)
  })
  return child
}
