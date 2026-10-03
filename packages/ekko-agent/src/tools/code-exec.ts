import { randomBytes } from 'node:crypto'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { delimiter, join } from 'node:path'
import {
  DEFAULT_CODE_EXEC_LANGUAGES,
  DEFAULT_CODE_EXEC_MAX_OUTPUT_BYTES,
  DEFAULT_CODE_EXEC_MAX_SOURCE_BYTES,
  DEFAULT_CODE_EXEC_MAX_STDERR_BYTES,
  DEFAULT_CODE_EXEC_MAX_TOOL_CALLS,
  DEFAULT_TOOL_EXECUTION_TIMEOUT_MS,
} from '../config'
import type { AgentTool, AgentToolContext, AgentToolResult } from './types'
import { workspaceTempEnvironment, workspaceTempRoot } from './workspace-temp'

export type CodeExecLanguage = typeof DEFAULT_CODE_EXEC_LANGUAGES[number]

export interface CodeExecInput extends Record<string, unknown> {
  language: CodeExecLanguage
  code: string
}

export type CodeExecToolDispatcher = (
  name: string,
  input: Record<string, unknown>,
  context?: AgentToolContext,
) => Promise<AgentToolResult>

export interface CodeExecToolOptions {
  dispatch?: CodeExecToolDispatcher
  allowedLanguages?: CodeExecLanguage[]
  nodeExecutable?: string
  pythonExecutable?: string
  timeoutMs?: number
  maxToolCalls?: number
  maxOutputBytes?: number
  maxStderrBytes?: number
  maxSourceBytes?: number
}

interface CodeExecRuntime {
  command: string
  argsPrefix: string[]
  scriptFileName: string
}

interface CodeExecRpcServer {
  host: string
  port: number
  token: string
  toolCallCount(): number
  close(): Promise<void>
}

interface CodeExecProcessResult {
  exitCode: number | null
  spawnError?: string
  stdout: CapturedOutput
  stderr: CapturedOutput
}

const CODE_EXEC_ALLOWED_TOOLS = new Set([
  'read_file',
  'write_file',
  'terminal_exec',
])
const RPC_MAX_REQUEST_BYTES = 2 * 1024 * 1024
const CHILD_KILL_GRACE_MS = 2_000

export class CodeExecTool implements AgentTool<CodeExecInput> {
  readonly definition: AgentTool['definition']

  private readonly dispatch?: CodeExecToolDispatcher
  private readonly allowedLanguages: CodeExecLanguage[]
  private readonly nodeExecutable: string
  private readonly pythonExecutable?: string
  private readonly timeoutMs: number
  private readonly maxToolCalls: number
  private readonly maxOutputBytes: number
  private readonly maxStderrBytes: number
  private readonly maxSourceBytes: number

  constructor(private readonly options: CodeExecToolOptions = {}) {
    this.dispatch = options.dispatch
    this.allowedLanguages = normalizedAllowedLanguages(options.allowedLanguages)
    this.definition = codeExecDefinition(this.allowedLanguages)
    this.nodeExecutable = options.nodeExecutable || process.execPath
    this.pythonExecutable = options.pythonExecutable
    this.timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TOOL_EXECUTION_TIMEOUT_MS)
    this.maxToolCalls = positiveInteger(options.maxToolCalls, DEFAULT_CODE_EXEC_MAX_TOOL_CALLS)
    this.maxOutputBytes = positiveInteger(options.maxOutputBytes, DEFAULT_CODE_EXEC_MAX_OUTPUT_BYTES)
    this.maxStderrBytes = positiveInteger(options.maxStderrBytes, DEFAULT_CODE_EXEC_MAX_STDERR_BYTES)
    this.maxSourceBytes = positiveInteger(options.maxSourceBytes, DEFAULT_CODE_EXEC_MAX_SOURCE_BYTES)
  }

  /** Rebind RPC dispatch when the owning registry is isolated for a run. */
  fork(dispatch: CodeExecToolDispatcher): CodeExecTool {
    return new CodeExecTool({ ...this.options, dispatch })
  }

  async execute(input: CodeExecInput, context: AgentToolContext = {}): Promise<AgentToolResult> {
    if (!this.dispatch) return codeExecFailure('code_exec tool dispatch is unavailable.')
    const language = normalizedLanguage(input.language, this.allowedLanguages)
    if (!language) {
      return codeExecFailure(
        `code_exec language must be one of: ${this.allowedLanguages.join(', ')}.`,
      )
    }
    const code = typeof input.code === 'string' ? input.code : ''
    if (!code.trim()) return codeExecFailure('code_exec requires non-empty source code.')
    const sourceBytes = Buffer.byteLength(code)
    if (sourceBytes > this.maxSourceBytes) {
      return codeExecFailure(
        `code_exec source exceeds the ${this.maxSourceBytes}-byte limit.`,
      )
    }
    if (context.signal?.aborted) return codeExecFailure('Code execution aborted.', { aborted: true })

    const startedAt = Date.now()
    const workDirectory = context.cwd || context.workspaceRoot || process.cwd()
    const tempDirectory = workspaceTempRoot(context)
    await mkdir(tempDirectory, { recursive: true })
    const stagingDirectory = await mkdtemp(join(tempDirectory, 'code-exec-'))
    const controller = new AbortController()
    const nestedContext = { ...context, signal: controller.signal }
    let timedOut = false
    let aborted = false
    let child: ChildProcess | undefined
    let forceKillTimer: NodeJS.Timeout | undefined
    const onExternalAbort = () => {
      aborted = true
      controller.abort()
      terminateChild(child)
    }
    context.signal?.addEventListener('abort', onExternalAbort, { once: true })

    let rpc: CodeExecRpcServer | undefined
    try {
      const runtime = this.resolveRuntime(language)
      if (!runtime) {
        return codeExecFailure(
          language === 'python'
            ? 'Python 3 is unavailable. Configure PYTHON or install python3.'
            : 'Node.js is unavailable.',
          { language },
        )
      }
      await this.writeRuntimeFiles(stagingDirectory, language, code)
      rpc = await startCodeExecRpcServer(
        this.dispatch,
        nestedContext,
        this.maxToolCalls,
      )
      if (controller.signal.aborted) throw new Error('Code execution aborted.')

      const childEnv = codeExecChildEnvironment({
        stagingDirectory,
        tempDirectory,
        language,
        rpc,
      })
      const timeout = setTimeout(() => {
        timedOut = true
        controller.abort()
        terminateChild(child)
      }, context.timeoutMs ?? this.timeoutMs)

      try {
        child = spawn(runtime.command, [
          ...runtime.argsPrefix,
          join(stagingDirectory, runtime.scriptFileName),
        ], {
          cwd: workDirectory,
          env: childEnv,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        const onInternalAbort = () => {
          terminateChild(child)
          if (child?.pid) {
            forceKillTimer = setTimeout(() => child?.kill('SIGKILL'), CHILD_KILL_GRACE_MS)
            forceKillTimer.unref?.()
          }
        }
        controller.signal.addEventListener('abort', onInternalAbort, { once: true })
        if (controller.signal.aborted) onInternalAbort()
        const processResult = await collectChildProcess(
          child,
          this.maxOutputBytes,
          this.maxStderrBytes,
        )
        controller.signal.removeEventListener('abort', onInternalAbort)
        return codeExecResult({
          language,
          processResult,
          timedOut,
          aborted,
          timeoutMs: context.timeoutMs ?? this.timeoutMs,
          toolCallsMade: rpc.toolCallCount(),
          durationMs: Date.now() - startedAt,
        })
      } finally {
        clearTimeout(timeout)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return codeExecFailure(message, {
        language,
        timedOut,
        aborted,
        durationMs: Date.now() - startedAt,
        toolCallsMade: rpc?.toolCallCount() ?? 0,
      })
    } finally {
      if (forceKillTimer) clearTimeout(forceKillTimer)
      context.signal?.removeEventListener('abort', onExternalAbort)
      controller.abort()
      terminateChild(child)
      await rpc?.close()
      await rm(stagingDirectory, { recursive: true, force: true })
    }
  }

  private resolveRuntime(language: CodeExecLanguage): CodeExecRuntime | undefined {
    if (language === 'node') {
      return {
        command: this.nodeExecutable,
        argsPrefix: [],
        scriptFileName: 'script.mjs',
      }
    }
    const python = resolvePythonRuntime(this.pythonExecutable)
    return python
      ? {
          ...python,
          scriptFileName: 'script.py',
        }
      : undefined
  }

  private async writeRuntimeFiles(
    directory: string,
    language: CodeExecLanguage,
    code: string,
  ): Promise<void> {
    if (language === 'node') {
      await Promise.all([
        writeFile(join(directory, 'ekko_tools.mjs'), NODE_TOOL_BRIDGE, { encoding: 'utf8', mode: 0o600 }),
        writeFile(join(directory, 'script.mjs'), code, { encoding: 'utf8', mode: 0o600 }),
      ])
      return
    }
    await Promise.all([
      writeFile(join(directory, 'ekko_tools.py'), PYTHON_TOOL_BRIDGE, { encoding: 'utf8', mode: 0o600 }),
      writeFile(join(directory, 'script.py'), code, { encoding: 'utf8', mode: 0o600 }),
    ])
  }
}

function normalizedLanguage(
  value: unknown,
  allowedLanguages: readonly CodeExecLanguage[] = DEFAULT_CODE_EXEC_LANGUAGES,
): CodeExecLanguage | undefined {
  const language = String(value || '').trim().toLowerCase()
  return allowedLanguages.find(candidate => candidate === language)
}

function normalizedAllowedLanguages(value?: CodeExecLanguage[]): CodeExecLanguage[] {
  const configured = value ?? [...DEFAULT_CODE_EXEC_LANGUAGES]
  return [...new Set(configured)].filter(language => DEFAULT_CODE_EXEC_LANGUAGES.includes(language))
}

function codeExecDefinition(languages: readonly CodeExecLanguage[]): AgentTool['definition'] {
  return {
    name: 'code_exec',
    description: [
      'Run a one-shot Node.js or Python script with programmatic access to selected Ekko tools.',
      'Use this whenever the user asks to run, execute, or evaluate Node.js, JavaScript, or Python source code, including a one-line snippet.',
      'Also use it for loops, branching, filtering, or three or more mechanical tool calls.',
      'Do not probe the language runtime with terminal_exec first; code_exec resolves the requested runtime itself.',
      'Only the script output is returned; intermediate nested tool results stay outside model context.',
      'Node scripts import from "./ekko_tools.mjs"; Python scripts import from "ekko_tools".',
      'Available nested tools: read_file, write_file, terminal_exec.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        language: {
          type: 'string',
          enum: [...languages],
          description: 'Script runtime. Use "node" for ESM with top-level await or "python" for Python 3.',
        },
        code: {
          type: 'string',
          description: [
            'Source code to execute. Print or console.log only the final reduced result.',
            'Node example: import { read_file } from "./ekko_tools.mjs"; const result = await read_file({ path: "README.md" }).',
            'Python example: from ekko_tools import read_file; result = read_file(path="README.md").',
            'Nested tools return objects with ok, content, error, and data fields.',
          ].join(' '),
        },
      },
      required: ['language', 'code'],
      additionalProperties: false,
    },
  }
}

function resolvePythonRuntime(explicit?: string): Omit<CodeExecRuntime, 'scriptFileName'> | undefined {
  const candidates: Array<{ command: string; argsPrefix: string[] }> = []
  if (explicit?.trim()) candidates.push({ command: explicit.trim(), argsPrefix: [] })
  if (process.env.PYTHON?.trim()) candidates.push({ command: process.env.PYTHON.trim(), argsPrefix: [] })
  candidates.push(
    { command: 'python3', argsPrefix: [] },
    { command: 'python', argsPrefix: [] },
  )
  if (process.platform === 'win32') candidates.push({ command: 'py', argsPrefix: ['-3'] })
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const key = JSON.stringify(candidate)
    if (seen.has(key)) continue
    seen.add(key)
    const probe = spawnSync(candidate.command, [...candidate.argsPrefix, '--version'], {
      encoding: 'utf8',
      shell: false,
      timeout: 2_000,
      windowsHide: true,
    })
    if (!probe.error && probe.status === 0) return candidate
  }
  return undefined
}

async function startCodeExecRpcServer(
  dispatch: CodeExecToolDispatcher,
  context: AgentToolContext,
  maxToolCalls: number,
): Promise<CodeExecRpcServer> {
  const host = '127.0.0.1'
  const token = randomBytes(32).toString('hex')
  const sockets = new Set<Socket>()
  let toolCallCount = 0
  const server = createServer(socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    let requestBytes = 0
    let buffer = ''
    let handled = false
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      if (handled) return
      requestBytes += Buffer.byteLength(chunk)
      if (requestBytes > RPC_MAX_REQUEST_BYTES) {
        handled = true
        writeRpcResponse(socket, { ok: false, error: 'code_exec RPC request is too large.' })
        return
      }
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      handled = true
      socket.pause()
      void handleRpcRequest(buffer.slice(0, newline))
    })

    const handleRpcRequest = async (raw: string) => {
      try {
        const request = JSON.parse(raw) as Record<string, unknown>
        if (request.token !== token) {
          writeRpcResponse(socket, { ok: false, error: 'Unauthorized code_exec RPC request.' })
          return
        }
        const toolName = String(request.tool || '').trim()
        if (!CODE_EXEC_ALLOWED_TOOLS.has(toolName)) {
          writeRpcResponse(socket, {
            ok: false,
            error: `Tool "${toolName}" is unavailable inside code_exec.`,
          })
          return
        }
        if (toolCallCount >= maxToolCalls) {
          writeRpcResponse(socket, {
            ok: false,
            error: `code_exec exceeded its ${maxToolCalls}-tool-call limit.`,
          })
          return
        }
        const input = request.input && typeof request.input === 'object' && !Array.isArray(request.input)
          ? request.input as Record<string, unknown>
          : {}
        toolCallCount += 1
        const result = await dispatch(toolName, input, context)
        writeRpcResponse(socket, compactToolResult(result))
      } catch (error) {
        writeRpcResponse(socket, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    await closeServer(server, sockets)
    throw new Error('code_exec RPC server failed to allocate a TCP port.')
  }
  return {
    host,
    port: address.port,
    token,
    toolCallCount: () => toolCallCount,
    close: () => closeServer(server, sockets),
  }
}

function writeRpcResponse(socket: Socket, value: unknown): void {
  if (socket.destroyed) return
  let response = safeJsonStringify(value)
  if (Buffer.byteLength(response) > RPC_MAX_REQUEST_BYTES) {
    response = safeJsonStringify({
      ok: false,
      error: 'Nested tool result exceeded the code_exec RPC response limit.',
    })
  }
  socket.end(`${response}\n`)
}

function compactToolResult(result: AgentToolResult): Record<string, unknown> {
  return {
    ok: result.ok,
    content: result.content,
    error: result.error,
    data: result.data,
  }
}

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>()
  try {
    return JSON.stringify(value, (_key, child) => {
      if (typeof child === 'bigint') return child.toString()
      if (!child || typeof child !== 'object') return child
      if (seen.has(child)) return '[circular value omitted]'
      seen.add(child)
      return child
    })
  } catch {
    return JSON.stringify({ ok: false, error: 'Result could not be serialized.' })
  }
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy()
  if (!server.listening) return
  await new Promise<void>(resolve => server.close(() => resolve()))
}

function codeExecChildEnvironment(input: {
  stagingDirectory: string
  tempDirectory: string
  language: CodeExecLanguage
  rpc: CodeExecRpcServer
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  const exactNames = new Set([
    'PATH',
    'HOME',
    'USER',
    'LANG',
    'TERM',
    'TMPDIR',
    'TMP',
    'TEMP',
    'SHELL',
    'LOGNAME',
    'SystemRoot',
    'ComSpec',
    'PATHEXT',
  ])
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (exactNames.has(key) || key.startsWith('LC_')) env[key] = value
  }
  Object.assign(env, workspaceTempEnvironment(input.tempDirectory))
  env.EKKO_CODE_RPC_HOST = input.rpc.host
  env.EKKO_CODE_RPC_PORT = String(input.rpc.port)
  env.EKKO_CODE_RPC_TOKEN = input.rpc.token
  env.PYTHONIOENCODING = 'utf-8'
  env.PYTHONUTF8 = '1'
  if (input.language === 'python') {
    env.PYTHONPATH = [
      input.stagingDirectory,
      process.env.PYTHONPATH,
    ].filter(Boolean).join(delimiter)
  }
  return env
}

async function collectChildProcess(
  child: ChildProcess,
  maxOutputBytes: number,
  maxStderrBytes: number,
): Promise<CodeExecProcessResult> {
  const stdout = new CapturedOutput(maxOutputBytes)
  const stderr = new CapturedOutput(maxStderrBytes)
  child.stdout?.on('data', chunk => stdout.append(Buffer.from(chunk)))
  child.stderr?.on('data', chunk => stderr.append(Buffer.from(chunk)))
  return await new Promise(resolve => {
    let settled = false
    const finish = (result: CodeExecProcessResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    child.once('error', error => finish({
      exitCode: null,
      spawnError: error.message,
      stdout,
      stderr,
    }))
    child.once('close', exitCode => finish({ exitCode, stdout, stderr }))
  })
}

function terminateChild(child?: ChildProcess): void {
  if (!child || child.killed) return
  try {
    child.kill('SIGTERM')
  } catch {
    // The process may already have exited.
  }
}

function codeExecResult(input: {
  language: CodeExecLanguage
  processResult: CodeExecProcessResult
  timedOut: boolean
  aborted: boolean
  timeoutMs: number
  toolCallsMade: number
  durationMs: number
}): AgentToolResult {
  const output = input.processResult.stdout.text()
  const stderr = input.processResult.stderr.text()
  const error = input.processResult.spawnError
    || (input.aborted
      ? 'Code execution aborted.'
      : input.timedOut
        ? `Code execution timed out after ${input.timeoutMs}ms.`
        : input.processResult.exitCode === 0
          ? undefined
          : `Script exited with code ${input.processResult.exitCode}.`)
  const payload = {
    status: error ? 'error' : 'completed',
    language: input.language,
    output,
    stderr,
    exitCode: input.processResult.exitCode,
    timedOut: input.timedOut,
    aborted: input.aborted,
    toolCallsMade: input.toolCallsMade,
    durationMs: input.durationMs,
    outputTruncated: input.processResult.stdout.truncated,
    stderrTruncated: input.processResult.stderr.truncated,
  }
  return {
    ok: !error,
    content: JSON.stringify(payload),
    error,
    data: payload,
  }
}

function codeExecFailure(error: string, data: Record<string, unknown> = {}): AgentToolResult {
  return {
    ok: false,
    content: JSON.stringify({ status: 'error', error, ...data }),
    error,
    data: { status: 'error', error, ...data },
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || Number(value) <= 0) return fallback
  return Math.floor(Number(value))
}

class CapturedOutput {
  private readonly chunks: Buffer[] = []
  private capturedBytes = 0
  totalBytes = 0

  constructor(private readonly maxBytes: number) {}

  append(chunk: Buffer): void {
    this.totalBytes += chunk.length
    if (this.capturedBytes >= this.maxBytes) return
    const kept = chunk.subarray(0, this.maxBytes - this.capturedBytes)
    this.chunks.push(kept)
    this.capturedBytes += kept.length
  }

  get truncated(): boolean {
    return this.totalBytes > this.capturedBytes
  }

  text(): string {
    const text = Buffer.concat(this.chunks).toString('utf8')
    if (!this.truncated) return text
    return `${text}\n\n... [OUTPUT TRUNCATED: ${this.totalBytes - this.capturedBytes} bytes omitted]`
  }
}

const NODE_TOOL_BRIDGE = String.raw`
import net from 'node:net'

const host = process.env.EKKO_CODE_RPC_HOST
const port = Number(process.env.EKKO_CODE_RPC_PORT)
const token = process.env.EKKO_CODE_RPC_TOKEN

export function callTool(tool, input = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port })
    let response = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      socket.write(JSON.stringify({ token, tool, input }) + '\n')
    })
    socket.on('data', chunk => { response += chunk })
    socket.on('error', reject)
    socket.on('end', () => {
      try {
        resolve(JSON.parse(response.trim()))
      } catch (error) {
        reject(new Error('Invalid code_exec RPC response: ' + error.message))
      }
    })
  })
}

export const read_file = input => callTool('read_file', input)
export const write_file = input => callTool('write_file', input)
export const terminal_exec = input => callTool('terminal_exec', input)
`

const PYTHON_TOOL_BRIDGE = String.raw`
import json
import os
import socket

_HOST = os.environ["EKKO_CODE_RPC_HOST"]
_PORT = int(os.environ["EKKO_CODE_RPC_PORT"])
_TOKEN = os.environ["EKKO_CODE_RPC_TOKEN"]

def call_tool(tool, **input):
    request = json.dumps({
        "token": _TOKEN,
        "tool": tool,
        "input": input,
    }, ensure_ascii=False).encode("utf-8") + b"\n"
    with socket.create_connection((_HOST, _PORT)) as connection:
        connection.sendall(request)
        response = b""
        while not response.endswith(b"\n"):
            chunk = connection.recv(65536)
            if not chunk:
                break
            response += chunk
    return json.loads(response.decode("utf-8").strip())

def read_file(path, **kwargs):
    return call_tool("read_file", path=path, **kwargs)

def write_file(path, content, **kwargs):
    return call_tool("write_file", path=path, content=content, **kwargs)

def terminal_exec(command, args=None, **kwargs):
    payload = dict(kwargs)
    payload["command"] = command
    if args is not None:
        payload["args"] = args
    return call_tool("terminal_exec", **payload)
`
