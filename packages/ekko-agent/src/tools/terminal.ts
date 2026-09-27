import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Transform, type TransformCallback } from 'node:stream'
import { finished } from 'node:stream/promises'
import type { AgentTool, AgentToolContext, AgentToolResult } from './types'
import { ensureToolAssetDirectory, ensureWorkspaceTempRoot, workspaceTempEnvironment } from './workspace-temp'

export const DEFAULT_TERMINAL_EXEC_MAX_OUTPUT_BYTES = 100_000
export const DEFAULT_TERMINAL_EXEC_MAX_STDERR_BYTES = 25_000
export const DEFAULT_TERMINAL_EXEC_MAX_ARTIFACT_BYTES = 25 * 1024 * 1024

export interface TerminalExecInput extends Record<string, unknown> {
  command: string
  args?: string[]
  cwd?: string
  timeoutMs?: number
}

export interface TerminalExecToolOptions {
  timeoutMs?: number
  platform?: NodeJS.Platform
  maxOutputBytes?: number
  maxStderrBytes?: number
  maxArtifactBytes?: number
}

export class TerminalExecTool implements AgentTool<TerminalExecInput> {
  readonly definition: AgentTool['definition']

  private readonly timeoutMs: number
  private readonly maxOutputBytes: number
  private readonly maxStderrBytes: number
  private readonly maxArtifactBytes: number

  constructor(options: TerminalExecToolOptions = {}) {
    this.timeoutMs = positiveInteger(options.timeoutMs, 30_000)
    this.maxOutputBytes = positiveInteger(options.maxOutputBytes, DEFAULT_TERMINAL_EXEC_MAX_OUTPUT_BYTES)
    this.maxStderrBytes = positiveInteger(options.maxStderrBytes, DEFAULT_TERMINAL_EXEC_MAX_STDERR_BYTES)
    this.maxArtifactBytes = positiveInteger(options.maxArtifactBytes, DEFAULT_TERMINAL_EXEC_MAX_ARTIFACT_BYTES)
    this.definition = terminalExecDefinition(options.platform ?? process.platform)
  }

  async execute(input: TerminalExecInput, context: AgentToolContext = {}): Promise<AgentToolResult> {
    const normalized = normalizeTerminalCommand(input.command, input.args)
    const args = normalized.args
    const baseDirectory = context.cwd || context.workspaceRoot || process.cwd()
    const cwd = input.cwd ? resolve(baseDirectory, input.cwd) : baseDirectory
    const timeoutMs = input.timeoutMs ?? context.timeoutMs ?? this.timeoutMs
    if (context.signal?.aborted) {
      return {
        ok: false,
        content: 'Command aborted.',
        error: 'Command aborted.',
        data: { command: normalized.command, args, cwd, originalCommand: input.command, aborted: true },
      }
    }

    const tempDirectory = await ensureWorkspaceTempRoot(context)
    const outputDirectory = join(tempDirectory, 'tool-assets')
    await ensureToolAssetDirectory(outputDirectory)
    const artifactPrefix = `${safeArtifactName(context.runId || 'run')}-${Date.now()}-${randomUUID()}`
    const stdoutArtifactPath = join(outputDirectory, `${artifactPrefix}.stdout.log`)
    const stderrArtifactPath = join(outputDirectory, `${artifactPrefix}.stderr.log`)
    return new Promise<AgentToolResult>((resolveResult) => {
      const child = spawn(normalized.command, args, {
        cwd,
        env: {
          ...process.env,
          ...workspaceTempEnvironment(tempDirectory),
        },
        shell: false,
        windowsHide: true,
      })
      const stdout = new BoundedOutputCapture(this.maxOutputBytes)
      const stderr = new BoundedOutputCapture(this.maxStderrBytes)
      const stdoutArtifact = createWriteStream(stdoutArtifactPath, { flags: 'wx', mode: 0o600 })
      const stderrArtifact = createWriteStream(stderrArtifactPath, { flags: 'wx', mode: 0o600 })
      const stdoutArtifactLimit = new ArtifactByteLimit(this.maxArtifactBytes)
      const stderrArtifactLimit = new ArtifactByteLimit(this.maxArtifactBytes)
      const stdoutArtifactDone = settleOutputArtifact(stdoutArtifact)
      const stderrArtifactDone = settleOutputArtifact(stderrArtifact)
      let spawnError: Error | undefined
      let timedOut = false
      let aborted = false

      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
      }, timeoutMs)
      const onAbort = () => {
        aborted = true
        child.kill('SIGTERM')
      }
      context.signal?.addEventListener('abort', onAbort, { once: true })

      pipeOutputArtifact(child.stdout, stdoutArtifactLimit, stdoutArtifact)
      pipeOutputArtifact(child.stderr, stderrArtifactLimit, stderrArtifact)
      child.stdout?.on('data', chunk => { stdout.append(Buffer.from(chunk)) })
      child.stderr?.on('data', chunk => { stderr.append(Buffer.from(chunk)) })
      child.on('error', error => {
        spawnError = error
      })
      child.on('close', async code => {
        clearTimeout(timer)
        context.signal?.removeEventListener('abort', onAbort)
        const [stdoutArtifactError, stderrArtifactError] = await Promise.all([
          stdoutArtifactDone,
          stderrArtifactDone,
        ])
        const keptStdoutArtifact = stdout.truncated && !stdoutArtifactError
        const keptStderrArtifact = stderr.truncated && !stderrArtifactError
        await Promise.all([
          keptStdoutArtifact ? undefined : unlink(stdoutArtifactPath).catch(() => undefined),
          keptStderrArtifact ? undefined : unlink(stderrArtifactPath).catch(() => undefined),
        ])
        const stdoutText = stdout.text(keptStdoutArtifact
          ? artifactLocation(stdoutArtifactPath, stdoutArtifactLimit)
          : undefined).trimEnd()
        const stderrText = stderr.text(keptStderrArtifact
          ? artifactLocation(stderrArtifactPath, stderrArtifactLimit)
          : undefined).trimEnd()
        const content = [stdoutText, stderrText].filter(Boolean).join('\n')
        const error = spawnError?.message
          || (aborted
            ? 'Command aborted.'
            : timedOut
              ? `Command timed out after ${timeoutMs}ms`
              : code === 0
                ? undefined
                : `Command exited with code ${code}`)
        resolveResult({
          ok: !spawnError && code === 0 && !timedOut && !aborted,
          content: content || error || '',
          error,
          data: {
            command: normalized.command,
            args,
            cwd,
            originalCommand: input.command,
            exitCode: code,
            stdout: stdoutText,
            stderr: stderrText,
            stdoutBytes: stdout.totalBytes,
            stderrBytes: stderr.totalBytes,
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
            ...(keptStdoutArtifact ? { stdoutArtifactPath } : {}),
            ...(keptStderrArtifact ? { stderrArtifactPath } : {}),
            ...(keptStdoutArtifact ? {
              stdoutArtifactBytes: stdoutArtifactLimit.writtenBytes,
              stdoutArtifactTruncated: stdoutArtifactLimit.truncated,
            } : {}),
            ...(keptStderrArtifact ? {
              stderrArtifactBytes: stderrArtifactLimit.writtenBytes,
              stderrArtifactTruncated: stderrArtifactLimit.truncated,
            } : {}),
            ...(stdoutArtifactError ? { stdoutArtifactError: stdoutArtifactError.message } : {}),
            ...(stderrArtifactError ? { stderrArtifactError: stderrArtifactError.message } : {}),
            timedOut,
            aborted,
            tempDirectory,
          },
        })
      })
    })
  }
}

class BoundedOutputCapture {
  private readonly prefixChunks: Buffer[] = []
  private prefixBytes = 0
  private tail = Buffer.alloc(0)
  totalBytes = 0

  constructor(private readonly maxBytes: number) {}

  get truncated(): boolean {
    return this.totalBytes > this.maxBytes
  }

  append(chunk: Buffer): void {
    this.totalBytes += chunk.length
    if (this.prefixBytes < this.maxBytes) {
      const kept = chunk.subarray(0, this.maxBytes - this.prefixBytes)
      if (kept.length) {
        this.prefixChunks.push(kept)
        this.prefixBytes += kept.length
      }
    }
    const tailBytes = Math.max(1, Math.floor(this.maxBytes / 3))
    this.tail = Buffer.concat([this.tail, chunk]).subarray(-tailBytes)
  }

  text(artifact?: OutputArtifactLocation): string {
    const prefix = Buffer.concat(this.prefixChunks)
    if (!this.truncated) return prefix.toString('utf8')
    const tailBytes = Math.max(1, Math.floor(this.maxBytes / 3))
    const headBytes = this.maxBytes - tailBytes
    const omittedBytes = Math.max(0, this.totalBytes - headBytes - this.tail.length)
    const location = artifact
      ? artifact.truncated
        ? ` The first ${artifact.bytes} bytes were saved to ${artifact.path}; the artifact reached its safety limit. Inspect it with read_file using offsets or a bounded search.`
        : ` Full output saved to ${artifact.path}; inspect it with read_file using offsets or a bounded search.`
      : ''
    const marker = `\n\n[terminal_exec output truncated: ${this.totalBytes} bytes total, ${omittedBytes} bytes omitted.${location}]\n\n`
    return `${prefix.subarray(0, headBytes).toString('utf8')}${marker}${this.tail.toString('utf8')}`
  }
}

interface OutputArtifactLocation {
  path: string
  bytes: number
  truncated: boolean
}

class ArtifactByteLimit extends Transform {
  writtenBytes = 0
  truncated = false

  constructor(private readonly maxBytes: number) {
    super()
  }

  override _transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
    const remaining = Math.max(0, this.maxBytes - this.writtenBytes)
    if (remaining > 0) {
      const kept = buffer.subarray(0, remaining)
      this.writtenBytes += kept.length
      if (kept.length) this.push(kept)
    }
    if (buffer.length > remaining) this.truncated = true
    callback()
  }
}

function pipeOutputArtifact(
  source: NodeJS.ReadableStream | null,
  limit: ArtifactByteLimit,
  artifact: ReturnType<typeof createWriteStream>,
): void {
  artifact.once('error', () => {
    limit.unpipe(artifact)
    limit.resume()
  })
  if (source) source.pipe(limit).pipe(artifact)
  else artifact.end()
}

function artifactLocation(path: string, limit: ArtifactByteLimit): OutputArtifactLocation {
  return {
    path,
    bytes: limit.writtenBytes,
    truncated: limit.truncated,
  }
}

async function settleOutputArtifact(stream: ReturnType<typeof createWriteStream>): Promise<Error | undefined> {
  try {
    await finished(stream)
    return undefined
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

function safeArtifactName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'run'
}

function terminalExecDefinition(platform: NodeJS.Platform): AgentTool['definition'] {
  const windows = platform === 'win32'
  const platformGuidance = windows
    ? [
        'This runtime is Windows: generate Windows-native commands.',
        'Do not use Unix-only commands such as sh, bash, ls, cat, grep, sed, awk, head, tail, which, or /bin/sh unless their availability was already established.',
        'Run native executables directly. For cmd built-ins, compound syntax, and .cmd or .bat launchers, explicitly invoke cmd.exe; for PowerShell syntax, explicitly invoke powershell.exe or pwsh.exe.',
      ]
    : platform === 'darwin'
      ? [
          'This runtime is macOS: generate macOS-native commands and remember that system utilities use BSD rather than GNU semantics.',
          'Run normal executables directly. Invoke sh or zsh explicitly only for shell syntax.',
        ]
      : [
          `This runtime is ${platform === 'linux' ? 'Linux' : platform}: generate native commands for this platform.`,
          'Run normal executables directly. Invoke sh or bash explicitly only for shell syntax.',
        ]

  return {
    name: 'terminal_exec',
    description: [
      'Run a CLI command, project script, test, build, package manager, or system executable.',
      'Prefer command as the executable and args as the argument array; shell string execution is not used.',
      ...platformGuidance,
      windows
        ? 'Commands are not confined to the workspace: explicit absolute Windows paths are supported.'
        : 'Commands are not confined to the workspace: explicit absolute paths and package-manager forms such as npx --dir are supported.',
      'Keep downloads, clones, extracted files, and generated intermediates under the current workspace (prefer .ekko-tmp) when workspace tools need to inspect them.',
      'Large stdout and stderr are returned as bounded previews; output artifacts are saved under .ekko-tmp/tool-assets up to a per-stream safety limit for paged read_file access or bounded searches.',
      'When the user asks to execute or evaluate Node.js, JavaScript, or Python source code, use code_exec instead, even for a one-line snippet.',
      'Destructive, privileged, remote-shell, publishing, and other dangerous commands require runtime authorization before execution.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: windows
            ? 'Executable command to run, such as git.exe, cmd.exe, or powershell.exe. Do not place a whole shell command line here.'
            : 'Executable command to run. Prefer a bare executable such as git, ls, or /bin/sh.',
        },
        args: { type: 'array', items: { type: 'string' }, description: 'Command arguments.' },
        cwd: { type: 'string', description: 'Working directory. Relative paths resolve from the current workspace; explicit absolute system paths are supported.' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  }
}

export function createTerminalTools(options: TerminalExecToolOptions = {}): AgentTool[] {
  return [new TerminalExecTool(options)]
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback
}

function normalizeTerminalCommand(command: string, args?: string[]): { command: string; args: string[] } {
  const normalizedArgs = Array.isArray(args) ? args.map(String) : []
  if (normalizedArgs.length > 0 || !/\s/.test(command.trim())) {
    return { command, args: normalizedArgs }
  }

  const parts = splitCommandLine(command)
  if (parts.length <= 1) return { command, args: normalizedArgs }
  return {
    command: parts[0],
    args: parts.slice(1),
  }
}

function splitCommandLine(command: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false

  for (const char of command.trim()) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\' && process.platform !== 'win32') {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current)
        current = ''
      }
      continue
    }
    current += char
  }

  if (escaped) current += '\\'
  if (current) parts.push(current)
  return parts
}
