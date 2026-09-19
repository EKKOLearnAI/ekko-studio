import { spawn, type ChildProcess } from 'child_process'
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
  let stdoutBuffer = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf-8')
    const lines = stdoutBuffer.split(/\r?\n/)
    stdoutBuffer = lines.pop() || ''
    for (const line of lines) {
      const event = parseCursorStreamJsonLine(line, { streamPartial: true })
      if (event) input.onEvent(event)
    }
  })
  child.stderr?.on('data', input.onStderr)
  child.on('error', input.onError)
  child.on('close', (code) => {
    const event = parseCursorStreamJsonLine(stdoutBuffer, { streamPartial: true })
    if (event) input.onEvent(event)
    input.onClose(code)
  })
  return child
}
