import { randomUUID } from 'crypto'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { spawn, type ChildProcess } from 'child_process'
import type { CodingAgentImageInput } from '../../protocol/types'
import { normalizeWindowsCommandPath, windowsCmdShimExecution, windowsCommandNeedsShell } from '../../../studio/public/windows-command'
import { parseGrokStreamingJsonLine, type GrokStreamEvent } from './streaming-json'

export interface GrokTurnProcessInput {
  command: string
  baseArgs: string[]
  rootDir: string
  workspaceDir: string
  env: NodeJS.ProcessEnv
  nativeSessionId: string
  resume: boolean
  input: string
  images: CodingAgentImageInput[]
  onEvent: (event: GrokStreamEvent) => void
  onStderr: (chunk: Buffer) => void
  onError: (error: Error) => void
  onClose: (code: number | null) => void
}

function normalizedMediaType(value: string): string {
  const mediaType = String(value || '').trim().toLowerCase()
  if (mediaType === 'image/jpg') return 'image/jpeg'
  return mediaType.startsWith('image/') ? mediaType : 'image/png'
}

function promptFileContent(input: string, images: CodingAgentImageInput[]): { extension: string; content: string } {
  if (images.length === 0) return { extension: 'md', content: `${input.trim()}\n` }
  const blocks: any[] = []
  if (input.trim()) blocks.push({ type: 'text', text: input.trim() })
  for (const image of images) {
    if (!image.path) continue
    blocks.push({
      type: 'image',
      data: readFileSync(image.path).toString('base64'),
      mimeType: normalizedMediaType(image.mediaType),
    })
  }
  return { extension: 'json', content: `${JSON.stringify(blocks)}\n` }
}

function spawnGrok(command: string, args: string[], input: GrokTurnProcessInput): ChildProcess {
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

export function buildGrokTurnArgs(
  baseArgs: string[],
  nativeSessionId: string,
  resume: boolean,
  promptPath: string,
): string[] {
  const sessionArgs = nativeSessionId
    ? resume
      ? ['--resume', nativeSessionId]
      : ['--session-id', nativeSessionId]
    : []
  return [
    ...baseArgs,
    ...sessionArgs,
    '--output-format', 'streaming-json',
    '--prompt-file', promptPath,
  ]
}

export function grokSessionExists(rootDir: string, workspaceDir: string, nativeSessionId: string): boolean {
  const sessionId = String(nativeSessionId || '').trim()
  if (!sessionId) return false
  const sessionsRoot = join(rootDir, 'sessions')
  const directPath = join(sessionsRoot, encodeURIComponent(workspaceDir), sessionId)
  if (existsSync(directPath)) return true

  // Grok replaces very long encoded workspace names with a slug plus hash.
  // Check each workspace bucket so failed first turns can still be resumed.
  try {
    return readdirSync(sessionsRoot, { withFileTypes: true })
      .some(entry => entry.isDirectory() && existsSync(join(sessionsRoot, entry.name, sessionId)))
  } catch {
    return false
  }
}

export function startGrokTurnProcess(input: GrokTurnProcessInput): ChildProcess {
  const prompt = promptFileContent(input.input, input.images)
  const promptPath = join(input.rootDir, `turn-prompt-${randomUUID()}.${prompt.extension}`)
  writeFileSync(promptPath, prompt.content, 'utf-8')
  const args = buildGrokTurnArgs(input.baseArgs, input.nativeSessionId, input.resume, promptPath)
  const cleanup = () => {
    try { rmSync(promptPath, { force: true }) } catch {}
  }
  let child: ChildProcess
  try {
    child = spawnGrok(input.command, args, input)
  } catch (error) {
    cleanup()
    throw error
  }
  let stdoutBuffer = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf-8')
    const lines = stdoutBuffer.split(/\r?\n/)
    stdoutBuffer = lines.pop() || ''
    for (const line of lines) {
      const event = parseGrokStreamingJsonLine(line)
      if (event) input.onEvent(event)
    }
  })
  child.stderr?.on('data', input.onStderr)
  child.on('error', (error) => {
    cleanup()
    input.onError(error)
  })
  child.on('close', (code) => {
    const event = parseGrokStreamingJsonLine(stdoutBuffer)
    if (event) input.onEvent(event)
    cleanup()
    input.onClose(code)
  })
  return child
}
