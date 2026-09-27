import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentTool, AgentToolContext, AgentToolResult } from './types'
import { workspaceTempRoot } from './workspace-temp'

type BrowserCommand = {
  command: string
  args: string[]
}

type BrowserCommandExecution = BrowserCommand & {
  windowsVerbatimArguments?: true
}

interface BrowserToolInput extends Record<string, unknown> {
  url?: string
  ref?: string
  text?: string
  direction?: string
  key?: string
  full?: boolean
  clear?: boolean
  expression?: string
  question?: string
  annotate?: boolean
}

const BROWSER_TOOL_TIMEOUT_MS = 120_000
const BROWSER_OPEN_TIMEOUT_MS = 180_000
const SCROLL_PIXELS = 500
const METADATA_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  '100.100.100.200',
])

const BROWSER_PASSTHROUGH_ENV = [
  'AGENT_BROWSER_ARGS',
  'AGENT_BROWSER_CHROME_FLAGS',
  'AGENT_BROWSER_ENGINE',
  'AGENT_BROWSER_IDLE_TIMEOUT_MS',
  'BROWSERBASE_API_KEY',
  'BROWSERBASE_PROJECT_ID',
  'BROWSER_USE_API_KEY',
  'FIRECRAWL_API_KEY',
  'FIRECRAWL_API_URL',
  'FIRECRAWL_BROWSER_TTL',
  'PLAYWRIGHT_BROWSERS_PATH',
]

const browserToolDefinitions: AgentTool['definition'][] = [
  {
    name: 'browser_navigate',
    description: 'Navigate to a URL in a browser session. Use this before other browser tools. Returns page metadata and a compact accessibility snapshot with refs.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_snapshot',
    description: 'Get an accessibility-tree snapshot of the current page. The snapshot includes refs such as @e1 for browser_click and browser_type.',
    parameters: {
      type: 'object',
      properties: {
        full: { type: 'boolean', description: 'Return the full snapshot instead of the compact interactive view.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'browser_click',
    description: 'Click an element by ref from browser_snapshot, for example @e5.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref, for example @e5.' },
      },
      required: ['ref'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_type',
    description: 'Clear and type text into an input element by ref from browser_snapshot.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref, for example @e3.' },
        text: { type: 'string', description: 'Text to type.' },
      },
      required: ['ref', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the current page up or down.',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction.' },
      },
      required: ['direction'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_back',
    description: 'Go back in browser history.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'browser_press',
    description: 'Press a keyboard key in the browser, such as Enter, Tab, Escape, ArrowDown, or Meta+K.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key or key chord to press.' },
      },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_get_images',
    description: 'List images on the current page, including src, alt text, and natural dimensions.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'browser_vision',
    description: 'Capture a screenshot of the current page and return its file path for visual inspection.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'What to inspect visually on the page.' },
        annotate: { type: 'boolean', description: 'Overlay numeric labels on interactive elements if supported.' },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_console',
    description: 'Read browser console messages and JavaScript errors. Optionally evaluate a small JavaScript expression in the page context.',
    parameters: {
      type: 'object',
      properties: {
        clear: { type: 'boolean', description: 'Clear console and error buffers after reading.' },
        expression: { type: 'string', description: 'Optional JavaScript expression to evaluate.' },
      },
      additionalProperties: false,
    },
  },
]

export class AgentBrowserTool implements AgentTool<BrowserToolInput> {
  readonly definition: AgentTool['definition']

  constructor(definition: AgentTool['definition']) {
    this.definition = definition
  }

  async execute(input: BrowserToolInput, context: AgentToolContext = {}): Promise<AgentToolResult> {
    switch (this.definition.name) {
      case 'browser_navigate':
        return this.navigate(input, context)
      case 'browser_snapshot':
        return this.snapshot(input, context)
      case 'browser_click':
        return this.simpleRefCommand('click', 'clicked', input, context)
      case 'browser_type':
        return this.type(input, context)
      case 'browser_scroll':
        return this.scroll(input, context)
      case 'browser_back':
        return this.simpleCommand('back', [], context)
      case 'browser_press':
        return this.press(input, context)
      case 'browser_get_images':
        return this.getImages(context)
      case 'browser_vision':
        return this.vision(input, context)
      case 'browser_console':
        return this.console(input, context)
      default:
        return failure(`Unsupported browser tool: ${this.definition.name}`)
    }
  }

  private async navigate(input: BrowserToolInput, context: AgentToolContext): Promise<AgentToolResult> {
    const rawUrl = getString(input.url)
    if (!rawUrl) return failure('browser_navigate requires url.')
    const url = normalizeUrl(rawUrl)
    const blocked = validateNavigationUrl(url)
    if (blocked) return failure(blocked, { url })

    const openResult = await runBrowserCommand(context, 'open', [url], { timeoutMs: BROWSER_OPEN_TIMEOUT_MS })
    if (!openResult.ok) return openResult

    const payload = objectFromResult(openResult)
    const response: Record<string, unknown> = {
      success: true,
      url: getNestedString(payload, ['data', 'url']) || getString(payload.url) || url,
      title: getNestedString(payload, ['data', 'title']) || getString(payload.title),
    }

    const snapshot = await runBrowserCommand(context, 'snapshot', ['-c'])
    if (snapshot.ok) {
      const snapshotPayload = objectFromResult(snapshot)
      const data = objectValue(snapshotPayload.data)
      const snapshotText = getString(data.snapshot) || getString(snapshotPayload.snapshot)
      const refs = objectValue(data.refs) || objectValue(snapshotPayload.refs)
      if (snapshotText) response.snapshot = truncateSnapshot(snapshotText)
      if (refs) response.element_count = Object.keys(refs).length
    }

    return okJson(response, { raw: payload })
  }

  private async snapshot(input: BrowserToolInput, context: AgentToolContext): Promise<AgentToolResult> {
    const args = input.full ? [] : ['-c']
    const result = await runBrowserCommand(context, 'snapshot', args)
    if (!result.ok) return result
    const payload = objectFromResult(result)
    const data = objectValue(payload.data)
    const snapshot = getString(data.snapshot) || getString(payload.snapshot)
    const refs = objectValue(data.refs) || objectValue(payload.refs)
    return okJson({
      success: true,
      snapshot: truncateSnapshot(snapshot),
      element_count: refs ? Object.keys(refs).length : 0,
    }, { raw: payload })
  }

  private async simpleRefCommand(command: string, resultKey: string, input: BrowserToolInput, context: AgentToolContext): Promise<AgentToolResult> {
    const ref = normalizeRef(getString(input.ref))
    if (!ref) return failure(`${this.definition.name} requires ref.`)
    const result = await runBrowserCommand(context, command, [ref])
    if (!result.ok) return result
    return okJson({ success: true, [resultKey]: ref }, { raw: objectFromResult(result) })
  }

  private async type(input: BrowserToolInput, context: AgentToolContext): Promise<AgentToolResult> {
    const ref = normalizeRef(getString(input.ref))
    if (!ref) return failure('browser_type requires ref.')
    const text = getString(input.text)
    const result = await runBrowserCommand(context, 'fill', [ref, text])
    if (!result.ok) return result
    return okJson({
      success: true,
      element: ref,
      typed: redactTypedText(text),
    }, { raw: objectFromResult(result) })
  }

  private async scroll(input: BrowserToolInput, context: AgentToolContext): Promise<AgentToolResult> {
    const direction = getString(input.direction) || 'down'
    if (direction !== 'up' && direction !== 'down') {
      return failure(`Invalid direction '${direction}'. Use 'up' or 'down'.`)
    }
    const result = await runBrowserCommand(context, 'scroll', [direction, String(SCROLL_PIXELS)])
    if (!result.ok) return result
    return okJson({ success: true, scrolled: direction }, { raw: objectFromResult(result) })
  }

  private async simpleCommand(command: string, args: string[], context: AgentToolContext): Promise<AgentToolResult> {
    const result = await runBrowserCommand(context, command, args)
    if (!result.ok) return result
    const payload = objectFromResult(result)
    return okJson({
      success: true,
      ...objectValue(payload.data),
    }, { raw: payload })
  }

  private async press(input: BrowserToolInput, context: AgentToolContext): Promise<AgentToolResult> {
    const key = getString(input.key)
    if (!key) return failure('browser_press requires key.')
    const result = await runBrowserCommand(context, 'press', [key])
    if (!result.ok) return result
    return okJson({ success: true, pressed: key }, { raw: objectFromResult(result) })
  }

  private async getImages(context: AgentToolContext): Promise<AgentToolResult> {
    const js = 'JSON.stringify([...document.images].map(img=>({src:img.src,alt:img.alt||"",width:img.naturalWidth,height:img.naturalHeight})).filter(img=>img.src&&!img.src.startsWith("data:")))'
    const result = await runBrowserCommand(context, 'eval', [js])
    if (!result.ok) return result
    const payload = objectFromResult(result)
    const raw = getNestedValue(payload, ['data', 'result']) ?? payload.result ?? '[]'
    let images: unknown[] = []
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      images = Array.isArray(parsed) ? parsed : []
    } catch {
      images = []
    }
    return okJson({ success: true, images, count: images.length }, { raw: payload })
  }

  private async vision(input: BrowserToolInput, context: AgentToolContext): Promise<AgentToolResult> {
    const question = getString(input.question)
    if (!question) return failure('browser_vision requires question.')
    const screenshotPath = browserScreenshotPath(context)
    const args = input.annotate ? ['--annotate', '--full', screenshotPath] : ['--full', screenshotPath]
    const result = await runBrowserCommand(context, 'screenshot', args, { timeoutMs: BROWSER_OPEN_TIMEOUT_MS })
    if (!result.ok) return result
    const payload = objectFromResult(result)
    const actualPath = getNestedString(payload, ['data', 'path']) || getString(payload.path) || screenshotPath
    return okJson({
      success: true,
      question,
      screenshot_path: actualPath,
      note: 'Screenshot captured. Inspect the image at screenshot_path to answer visual questions.',
      annotations: getNestedValue(payload, ['data', 'annotations']) ?? payload.annotations,
    }, { raw: payload })
  }

  private async console(input: BrowserToolInput, context: AgentToolContext): Promise<AgentToolResult> {
    const expression = getString(input.expression)
    if (expression) {
      const policyError = validateConsoleExpression(expression)
      if (policyError) return failure(policyError)
      const result = await runBrowserCommand(context, 'eval', [expression])
      if (!result.ok) return result
      const payload = objectFromResult(result)
      return okJson({
        success: true,
        result: getNestedValue(payload, ['data', 'result']) ?? payload.result,
      }, { raw: payload })
    }

    const args = input.clear ? ['--clear'] : []
    const consoleResult = await runBrowserCommand(context, 'console', args)
    const errorsResult = await runBrowserCommand(context, 'errors', args)
    const consolePayload = objectFromResult(consoleResult)
    const errorsPayload = objectFromResult(errorsResult)
    const messages = arrayValue(getNestedValue(consolePayload, ['data', 'messages']) ?? consolePayload.messages)
    const errors = arrayValue(getNestedValue(errorsPayload, ['data', 'errors']) ?? errorsPayload.errors)
    return okJson({
      success: consoleResult.ok || errorsResult.ok,
      console_messages: messages,
      js_errors: errors,
      total_messages: messages.length,
      total_errors: errors.length,
    }, { raw: { console: consolePayload, errors: errorsPayload } })
  }
}

export function createBrowserTools(): AgentTool[] {
  return browserToolDefinitions.map(definition => new AgentBrowserTool(definition))
}

export function isAgentBrowserAvailable(): boolean {
  return resolveAgentBrowser() !== null
}

async function runBrowserCommand(
  context: AgentToolContext,
  browserCommand: string,
  browserArgs: string[],
  options: { timeoutMs?: number } = {},
): Promise<AgentToolResult> {
  if (context.signal?.aborted) return failure('Browser command aborted.', { aborted: true })

  const resolved = resolveAgentBrowser()
  if (!resolved) {
    return failure(
      'agent-browser CLI not found. Browser tools require an existing agent-browser installation from this project or the Hermes runtime.',
    )
  }

  const sessionName = browserSessionName(context)
  const socketDir = browserSocketDir(sessionName)
  mkdirSync(socketDir, { recursive: true, mode: 0o700 })

  const args = [
    ...resolved.args,
    '--session',
    sessionName,
    '--json',
    browserCommand,
    ...browserArgs,
  ]
  const timeoutMs = options.timeoutMs ?? context.timeoutMs ?? BROWSER_TOOL_TIMEOUT_MS
  const cwd = context.cwd || context.workspaceRoot || process.cwd()
  const env = browserEnv(socketDir)

  return new Promise<AgentToolResult>((resolve) => {
    const stdoutPath = path.join(socketDir, `_stdout_${browserCommand}_${Date.now()}`)
    const stderrPath = path.join(socketDir, `_stderr_${browserCommand}_${Date.now()}`)
    const stdoutFd = openSync(stdoutPath, 'w', 0o600)
    const stderrFd = openSync(stderrPath, 'w', 0o600)
    const execution = browserCommandExecution(resolved, args)
    const child = spawn(execution.command, execution.args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      ...(execution.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      stdio: ['ignore', stdoutFd, stderrFd],
    })
    closeSync(stdoutFd)
    closeSync(stderrFd)
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let aborted = false

    const finish = (result: AgentToolResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      context.signal?.removeEventListener('abort', onAbort)
      cleanupCommandOutput(stdoutPath, stderrPath)
      resolve(result)
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)
    const onAbort = () => {
      aborted = true
      child.kill('SIGTERM')
    }

    context.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', error => {
      const output = readCommandOutput(stdoutPath, stderrPath)
      stdout = output.stdout
      stderr = output.stderr
      finish(failure(error.message, commandData(resolved, args, browserCommand, browserArgs, stdout, stderr)))
    })
    child.on('close', code => {
      const output = readCommandOutput(stdoutPath, stderrPath)
      stdout = output.stdout
      stderr = output.stderr
      if (aborted) {
        finish(failure('Browser command aborted.', commandData(resolved, args, browserCommand, browserArgs, stdout, stderr, {
          exitCode: code,
          aborted: true,
        })))
        return
      }
      if (timedOut) {
        finish(failure(`Browser command timed out after ${timeoutMs}ms`, commandData(resolved, args, browserCommand, browserArgs, stdout, stderr, {
          exitCode: code,
          timedOut: true,
        })))
        return
      }

      const parsed = parseBrowserJson(stdout)
      const success = parsed ? parsed.success !== false : code === 0
      const content = parsed
        ? JSON.stringify(parsed)
        : [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n')
      finish({
        ok: code === 0 && success,
        content,
        error: code === 0 && success ? undefined : errorFromPayload(parsed) || stderr.trim() || `Browser command exited with code ${code}`,
        data: commandData(resolved, args, browserCommand, browserArgs, stdout, stderr, {
          exitCode: code,
          parsed,
        }),
      })
    })
  })
}

function readCommandOutput(stdoutPath: string, stderrPath: string): { stdout: string; stderr: string } {
  return {
    stdout: readFileIfExists(stdoutPath),
    stderr: readFileIfExists(stderrPath),
  }
}

function readFileIfExists(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    return ''
  }
}

function cleanupCommandOutput(stdoutPath: string, stderrPath: string): void {
  for (const filePath of [stdoutPath, stderrPath]) {
    try {
      unlinkSync(filePath)
    } catch {
      // Best-effort cleanup only.
    }
  }
}

function resolveAgentBrowser(): BrowserCommand | null {
  const override = process.env.AGENT_BROWSER_BIN
  if (override) return { command: override, args: [] }

  const binary = process.platform === 'win32' ? 'agent-browser.cmd' : 'agent-browser'
  const localCandidates = [
    ...workspaceRootCandidates().flatMap(root => [
      path.resolve(root, 'node_modules', '.bin', binary),
      path.resolve(root, 'packages', 'ekko-agent', 'node_modules', '.bin', binary),
    ]),
    path.resolve(packageRoot(), 'node_modules', '.bin', binary),
    path.join(os.homedir(), '.hermes', 'node', 'bin', binary),
    path.join(os.homedir(), '.hermes', 'node_modules', '.bin', binary),
  ]
  for (const candidate of localCandidates) {
    if (existsSync(candidate)) return { command: candidate, args: [] }
  }

  const fromPath = findExecutable(binary, browserPath())
  if (fromPath) return { command: fromPath, args: [] }

  return null
}

const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g

function browserCommandExecution(resolved: BrowserCommand, args: string[]): BrowserCommandExecution {
  const command = process.platform === 'win32'
    ? normalizeWindowsCommandPath(resolved.command)
    : resolved.command
  if (process.platform !== 'win32' || !windowsCommandNeedsShell(command)) {
    return { command, args }
  }

  const shellCommand = [
    escapeWindowsCmdCommand(command),
    ...args.map(escapeWindowsCmdArgument),
  ].join(' ')
  return {
    command: process.env.ComSpec || process.env.COMSPEC || process.env.comspec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${shellCommand}"`],
    windowsVerbatimArguments: true,
  }
}

function normalizeWindowsCommandPath(command: string): string {
  const trimmed = command.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function windowsCommandNeedsShell(command: string): boolean {
  const extension = path.extname(normalizeWindowsCommandPath(command)).toLowerCase()
  return extension === '.cmd' || extension === '.bat'
}

function escapeWindowsCmdCommand(value: string): string {
  return normalizeWindowsCommandPath(value).replace(CMD_META_CHARS, '^$1')
}

function escapeWindowsCmdArgument(value: string): string {
  let escaped = String(value)
  escaped = escaped.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
  escaped = escaped.replace(/(?=(\\+?)?)\1$/, '$1$1')
  return `"${escaped}"`.replace(CMD_META_CHARS, '^$1')
}

function browserEnv(socketDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: browserPath(),
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    AGENT_BROWSER_SOCKET_DIR: socketDir,
    AGENT_BROWSER_IDLE_TIMEOUT_MS: process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS || '600000',
  }
  for (const key of BROWSER_PASSTHROUGH_ENV) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return env
}

function browserPath(): string {
  const parts = [
    ...workspaceRootCandidates().flatMap(root => [
      path.resolve(root, 'node_modules', '.bin'),
      path.resolve(root, 'packages', 'ekko-agent', 'node_modules', '.bin'),
    ]),
    path.resolve(packageRoot(), 'node_modules', '.bin'),
    path.join(os.homedir(), '.hermes', 'node', 'bin'),
    path.join(os.homedir(), '.hermes', 'node'),
    path.join(os.homedir(), '.hermes', 'node_modules', '.bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    process.env.PATH || '',
  ]
  return unique(parts.filter(Boolean)).join(path.delimiter)
}

function workspaceRootCandidates(): string[] {
  return unique([
    process.env.HERMES_WEB_UI_DIR || '',
    process.env.INIT_CWD || '',
    process.cwd(),
    path.resolve(__dirname, '..', '..', '..', '..'),
  ].filter(Boolean))
}

function packageRoot(): string {
  return path.resolve(__dirname, '..', '..')
}

function findExecutable(name: string, searchPath: string): string | null {
  for (const dir of searchPath.split(path.delimiter)) {
    const candidate = path.join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function browserSessionName(context: AgentToolContext): string {
  const raw = context.browserSessionId || context.sessionId || 'default'
  return `e_${shortHash(raw)}`
}

function browserSocketDir(sessionName: string): string {
  return path.join(shortTempDir(), `eab_${sessionName}`)
}

const BROWSER_SOCKET_DIR_LIMIT = 40
const BROWSER_SOCKET_LEAF = 'eab_e_0123456789'

function shortTempDir(): string {
  if (process.env.EKKO_AGENT_BROWSER_TMPDIR) return process.env.EKKO_AGENT_BROWSER_TMPDIR
  if (process.platform !== 'win32' && existsSync('/tmp')) return '/tmp'
  const candidates = [
    os.tmpdir(),
    process.env.SystemRoot ? path.join(process.env.SystemRoot, 'Temp') : '',
  ].filter(candidate => candidate.length > 0)
  return candidates.find(candidate => (
    existsSync(candidate) && path.join(candidate, BROWSER_SOCKET_LEAF).length < BROWSER_SOCKET_DIR_LIMIT
  )) || os.tmpdir()
}

function shortHash(value: string): string {
  return createHash('sha256').update(value || 'default').digest('hex').slice(0, 10)
}

function browserScreenshotPath(context: AgentToolContext): string {
  const dir = path.join(workspaceTempRoot(context), 'browser-screenshots', browserSessionName(context))
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return path.join(dir, `browser_screenshot_${Date.now()}_${Math.random().toString(16).slice(2)}.png`)
}

function normalizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || trimmed.startsWith('about:')) return trimmed
  return `https://${trimmed}`
}

function validateNavigationUrl(url: string): string | null {
  if (/(sk-|xox[baprs]-|gh[pousr]_|AIza)[A-Za-z0-9_\-]{12,}/.test(decodeURIComponentSafe(url))) {
    return 'Blocked: URL contains what appears to be an API key or token. Secrets must not be sent in URLs.'
  }
  if (url.startsWith('about:')) return null
  try {
    const parsed = new URL(url)
    if (METADATA_HOSTS.has(parsed.hostname.toLowerCase()) || parsed.hostname.toLowerCase().endsWith('.metadata.google.internal')) {
      return 'Blocked: URL targets a cloud metadata endpoint.'
    }
  } catch {
    return 'Invalid URL.'
  }
  return null
}

function validateConsoleExpression(expression: string): string | null {
  const lowered = expression.toLowerCase()
  const blocked = [
    'process.env',
    'localstorage',
    'sessionstorage',
    'document.cookie',
    'indexeddb',
    'fetch("file:',
    "fetch('file:",
  ]
  return blocked.some(pattern => lowered.includes(pattern))
    ? 'Blocked: browser_console expression attempts to access sensitive browser or runtime state.'
    : null
}

function parseBrowserJson(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed)
    return objectValue(parsed)
  } catch {
    const lines = trimmed.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    for (const line of lines.reverse()) {
      try {
        return objectValue(JSON.parse(line))
      } catch {
        // Try the previous line.
      }
    }
    const start = trimmed.indexOf('{')
    if (start >= 0) {
      try {
        return objectValue(JSON.parse(trimmed.slice(start)))
      } catch {
        return null
      }
    }
    return null
  }
}

function okJson(payload: Record<string, unknown>, extra?: Record<string, unknown>): AgentToolResult {
  return {
    ok: payload.success !== false,
    content: JSON.stringify(payload),
    data: extra ? { ...payload, ...extra } : payload,
    error: payload.success === false ? getString(payload.error) || 'Browser tool failed.' : undefined,
  }
}

function failure(message: string, data?: Record<string, unknown>): AgentToolResult {
  return {
    ok: false,
    content: JSON.stringify({ success: false, error: message }),
    error: message,
    data,
  }
}

function commandData(
  resolved: BrowserCommand,
  args: string[],
  browserCommand: string,
  browserArgs: string[],
  stdout: string,
  stderr: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    command: resolved.command,
    args: redactCommandArgs(args, browserCommand, browserArgs),
    browserCommand,
    browserArgs: redactBrowserArgs(browserCommand, browserArgs),
    stdout,
    stderr,
    ...extra,
  }
}

function redactCommandArgs(args: string[], browserCommand: string, browserArgs: string[]): string[] {
  if (!browserArgs.length) return args
  return [
    ...args.slice(0, args.length - browserArgs.length),
    ...redactBrowserArgs(browserCommand, browserArgs),
  ]
}

function redactBrowserArgs(command: string, args: string[]): string[] {
  if (command === 'fill' && args.length >= 2) return [args[0], redactTypedText(args[1])]
  return args.map(value => value.length > 1000 ? `[${value.length} chars]` : value)
}

function objectFromResult(result: AgentToolResult): Record<string, unknown> {
  const data = objectValue(result.data)
  const parsed = objectValue(data.parsed)
  if (parsed) return parsed
  try {
    return objectValue(JSON.parse(result.content)) || {}
  } catch {
    return {}
  }
}

function errorFromPayload(payload: Record<string, unknown> | null): string | undefined {
  return getString(payload?.error) || getNestedString(payload ?? {}, ['data', 'error'])
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function getNestedString(value: Record<string, unknown>, pathParts: string[]): string {
  return getString(getNestedValue(value, pathParts))
}

function getNestedValue(value: Record<string, unknown>, pathParts: string[]): unknown {
  let current: unknown = value
  for (const part of pathParts) {
    const object = objectValue(current)
    if (!object) return undefined
    current = object[part]
  }
  return current
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function normalizeRef(ref: string): string {
  const trimmed = ref.trim()
  if (!trimmed) return ''
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`
}

function truncateSnapshot(snapshot: string): string {
  if (snapshot.length <= 12_000) return snapshot
  return `${snapshot.slice(0, 12_000)}\n\n[Snapshot truncated]`
}

function redactTypedText(text: string): string {
  if (text.length > 200) return `[${text.length} chars]`
  if (/(sk-|xox[baprs]-|gh[pousr]_|AIza)[A-Za-z0-9_\-]{12,}/.test(text)) return '[redacted]'
  return text
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
