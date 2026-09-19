import { studioMcpCapabilities } from '../../studio/public/runs/mcp-capabilities'
import { prepareDshRuntime, DSH_API_KEY_ENV } from './dsh/runtime-config'
import { readDshMcpServers, validateDshSettings } from './dsh/config'
import { createDshHost } from './dsh/host'
import { OPENCODE_FREE_PROVIDER, openCodeFreeRuntime } from '../../studio/contracts/opencode-free'
import { beginAgentPreparation } from './update-lock'
import { execFile, spawn } from 'child_process'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'crypto'
import { existsSync, readdirSync, realpathSync } from 'fs'
import { chmod, copyFile, cp, lstat, mkdir, open, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { delimiter, dirname, join } from 'path'
import { promisify } from 'util'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { getWebUiHome } from '../../studio/public/config'
import { getProfileDir, PROVIDER_ENV_MAP, readConfigYamlForProfile, safeReadFile } from '../../studio/public/profile-config'
import { getCompatibleCustomProviders } from '../../studio/contracts/provider-compat'
import { registerClaudeCodeProxyTarget } from './claude-code/proxy'
import { registerCodexProxyTarget, restoreCodexProxyTarget } from './codex/proxy'
import { compactCodexThread } from './runtime/codex-compact'
import { hermesPromptDocument, writeManagedPromptFile } from './prompt-file'
import type { ApiMode, CodingAgentImageInput } from '../protocol/types'
import { PROVIDER_PRESETS } from '../../studio/contracts/providers'
import { getModelContextLength, getModelRuntimeCapabilities } from '../../studio/public/provider-runtime'
import { getSystemPrompt, studioMcpUsageGuidelines } from '../../studio/public/runs/prompt'
import { codingAgentRunManager } from './runtime/run-manager'
import { mergePiSettings, userSettingsProvidesPiMcpAdapter } from './pi/settings'
import { PI_EXTENDED_THINKING_LEVEL_MAP, piModelSupportsThinking } from './pi/thinking'
import { GROK_API_KEY_ENV, GROK_CODING_AGENT_DEFINITION, GROK_PROVIDER_ID } from './grok/definition'
import { getDisabledManagedMcpServers, getManagedMcpServerOverride } from './mcp-overrides'
import {
  grokSettingsConfig,
  grokUserMcpConfig,
  mergeGrokConfigWithManagedMcp,
  mergeGrokSettingsConfig,
  mergeGrokUserMcpConfig,
  prepareGlobalGrokRuntime,
  prepareScopedGrokRuntime,
} from './grok/config'
import { getSession, updateSession, type HermesSessionRow } from '../../studio/public/sessions'
import type { SessionState } from '../../studio/contracts/runs/session'
import { normalizeWindowsCommandPath, windowsCmdShimExecution, windowsCommandNeedsShell, type WindowsCommandExecution } from '../../studio/public/windows-command'
import { updateAgentStatus } from '../../studio/public/agent-status-registry'
import { logger } from '../../studio/public/logging'
import { assertScopedCodingAgentProviderAllowed } from '../protocol/provider-policy'
import type { CodingAgentRuntime } from '../../studio/contracts/agents/runtime'
import { defaultCodingAgentWorkspace } from '../../studio/public/workspace-manager'
import { isolateUnhealthyRuntimeMcpServers } from './mcp-runtime-isolation'
import { getCodingAgentGlobalHome } from '../../studio/public/coding-agent-global-home'

const execFileAsync = promisify(execFile)
const LAUNCH_API_MODES = new Set<ApiMode>(['chat_completions', 'codex_responses', 'anthropic_messages'])
const CODING_AGENT_HOME_DIR = 'coding-agent'
const CODEX_MODEL_CATALOG_FILE = 'codex-model-catalog.json'
const CODEX_CATALOG_BASE_INSTRUCTIONS = 'You are Codex, a coding agent. Be precise, safe, and helpful.'
const NODE_ENVIRONMENT_MISSING_CODE = 'node_environment_missing'
const POSIX_LAUNCHER_FILE = 'launch.sh'
const WINDOWS_LAUNCHER_FILE = 'launch.ps1'
const CLAUDE_CODE_SKIP_PERMISSIONS_ARGS = ['--dangerously-skip-permissions']
const CLAUDE_CODE_TASK_PLAN_TOOL = 'mcp__ekko-studio-interaction__ekko_studio_update_plan'
const CLAUDE_CODE_ROOT_PERMISSION_ARGS = [
  '--permission-mode',
  'auto',
  '--allowedTools',
  CLAUDE_CODE_TASK_PLAN_TOOL,
]
// Claude Code auto-compact is on by default, but Studio never tells it the
// model context window, so it can compact too late for the 20MB proxy body
// limit. Mirror Hermes' 50% compression budget and pass Studio's window.
const CLAUDE_CODE_AUTO_COMPACT_PERCENT = 50
const PI_MCP_ADAPTER_PACKAGE = 'pi-mcp-adapter'
const OFFICIAL_NPM_REGISTRY = 'https://registry.npmjs.org'
const PI_PROVIDER_ID = 'hermes-studio'
const PI_PROXY_TARGET_FILE = 'proxy-target.json'
const PI_DYNAMIC_PROMPT_FILE = 'dynamic-system-prompt.md'
const PI_STUDIO_EXTENSION_FILE = 'hermes-studio-runtime.ts'
const OPENCODE_PROVIDER_ID = 'hermes-studio'
const OPENCODE_CONFIG_FILE = 'opencode.json'
const OPENCODE_DATABASE_FILE = 'opencode.db'
const OPENCODE_API_KEY_ENV = 'HERMES_OPENCODE_API_KEY'
const OPENCODE_RUNTIME_CONFIG_ENV = 'OPENCODE_CONFIG_CONTENT'
const OPENCODE_SHARED_CONFIG_DIRS = [
  'agent',
  'agents',
  'command',
  'commands',
  'plugin',
  'plugins',
  'skill',
  'skills',
] as const
const PI_PROXY_TARGET_KEY_FILE = '.pi-proxy-target.key'
const PI_PROXY_TARGET_LEGACY_AAD = Buffer.from('hermes-studio/pi-proxy-target/v1', 'utf8')
// Codex ToolSearch became stable in 0.128; always-defer was removed in 0.142.
const CODEX_TOOL_SEARCH_MIN_VERSION = '0.128.0'
const CODEX_TOOL_SEARCH_ALWAYS_DEFER_REMOVED_VERSION = '0.142.0'
const CODEX_VERSION_CACHE_TTL_MS = 5 * 60 * 1000
const HERMES_MCP_SERVERS: ReadonlyArray<{ name: string; toolset: string }> = [
  { name: 'ekko-studio-api', toolset: 'api' },
  { name: 'ekko-studio-browser', toolset: 'browser' },
  { name: 'ekko-studio-devices', toolset: 'devices' },
  { name: 'ekko-studio-use', toolset: 'use' },
  { name: 'ekko-studio-interaction', toolset: 'plan' },
]
const HERMES_MCP_SERVER_NAMES: Set<string> = new Set(HERMES_MCP_SERVERS.map(server => server.name))
const LEGACY_HERMES_MCP_SERVER_NAMES = new Set([
  'ekko-studio-plan',
  'hermes-studio-api',
  'hermes-studio-browser',
  'hermes-studio-devices',
  'hermes-studio-use',
  'hermes-studio', 'hermes-studio-mcp', 'ekko-studio-mcp', 'hermes-web-ui-mcp',
])
const LEGACY_HERMES_MCP_COMMANDS = new Set([
  'hermes-lan-peer-mcp',
  'hermes-devices-mcp',
  'hermes-web-ui-mcp',
  'ekko-studio-mcp',
  'hermes-studio-mcp',
])
const HERMES_MCP_MANAGED_ENV_KEY = 'HERMES_WEB_UI_MANAGED_MCP'
const HERMES_STUDIO_SESSION_ENV_KEY = 'HERMES_STUDIO_SESSION_ID'
const GLOBAL_CODEX_SHADOW_LINK_DIRS = new Set(['memories', 'plugins', 'rules', 'skills', 'vendor_imports', 'visualizations'])

let cachedCodexVersion: { version: string; checkedAt: number } | null = null

interface EncryptedPiProxyApiKey {
  v: 1 | 2
  algorithm: 'aes-256-gcm'
  iv: string
  tag: string
  ciphertext: string
}

function piProxyTargetAad(input: Record<string, unknown>, token: string): Buffer {
  return Buffer.from(JSON.stringify({
    v: 2,
    profile: String(input.profile || ''),
    provider: String(input.provider || ''),
    model: String(input.model || ''),
    baseUrl: String(input.baseUrl || ''),
    apiMode: String(input.apiMode || ''),
    reasoningEffort: String(input.reasoningEffort || ''),
    agentId: String(input.agentId || ''),
    agentSessionId: String(input.agentSessionId || ''),
    chatSessionId: String(input.chatSessionId || ''),
    token,
  }), 'utf8')
}

async function atomicWritePrivateFile(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporaryPath, 'wx', 0o600)
  try {
    await handle.writeFile(content)
    await handle.sync()
    await handle.close()
  } catch (err) {
    await handle.close().catch(() => {})
    await rm(temporaryPath, { force: true }).catch(() => {})
    throw err
  }
  try {
    await rename(temporaryPath, path)
    await chmod(path, 0o600)
  } catch (err) {
    await rm(temporaryPath, { force: true }).catch(() => {})
    throw err
  }
}

function piProxyTargetKeyPath(): string {
  return join(getWebUiHome(), CODING_AGENT_HOME_DIR, PI_PROXY_TARGET_KEY_FILE)
}

async function readOrCreatePiProxyTargetKey(): Promise<Buffer> {
  const path = piProxyTargetKeyPath()
  await mkdir(dirname(path), { recursive: true })
  try {
    const existing = await readFile(path)
    if (existing.length !== 32) throw new Error(`Invalid Pi proxy target encryption key length: ${existing.length}`)
    await chmod(path, 0o600)
    return existing
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err
  }

  const generated = randomBytes(32)
  try {
    await writeFile(path, generated, { mode: 0o600, flag: 'wx' })
    return generated
  } catch (err: any) {
    if (err?.code !== 'EEXIST') throw err
    const existing = await readFile(path)
    if (existing.length !== 32) throw new Error(`Invalid Pi proxy target encryption key length: ${existing.length}`)
    await chmod(path, 0o600)
    return existing
  }
}

async function encryptPiProxyApiKey(
  apiKey: string,
  input: Record<string, unknown>,
  token: string,
): Promise<EncryptedPiProxyApiKey> {
  const key = await readOrCreatePiProxyTargetKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(piProxyTargetAad(input, token))
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()])
  return {
    v: 2,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
}

async function decryptPiProxyApiKey(
  value: unknown,
  input: Record<string, unknown>,
  token: string,
): Promise<string | null> {
  const encrypted = value as Partial<EncryptedPiProxyApiKey> | null
  if ((encrypted?.v !== 1 && encrypted?.v !== 2) || encrypted.algorithm !== 'aes-256-gcm') return null
  if (!encrypted.iv || !encrypted.tag || typeof encrypted.ciphertext !== 'string') return null
  const key = await readOrCreatePiProxyTargetKey()
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.iv, 'base64'))
  decipher.setAAD(encrypted.v === 1 ? PI_PROXY_TARGET_LEGACY_AAD : piProxyTargetAad(input, token))
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

async function serializePiProxyTarget(
  input: Record<string, unknown>,
  apiKey: string,
  token: string,
): Promise<string> {
  return `${JSON.stringify({
    input,
    apiKeyEncrypted: await encryptPiProxyApiKey(apiKey, input, token),
    token,
  }, null, 2)}\n`
}

interface CommandExecution {
  command: string
  args: string[]
  windowsVerbatimArguments?: WindowsCommandExecution['windowsVerbatimArguments']
}

export type CodingAgentId = CodingAgentRuntime

export interface CodingAgentDefinition {
  id: CodingAgentId
  name: string
  provider: string
  command: string
  packageName: string
}

export interface CodingAgentToolStatus extends CodingAgentDefinition {
  installed: boolean
  version: string
  rawVersion: string
  source: 'user-cli' | 'not-installed'
  path: string
  error?: string
}

export interface CodingAgentsStatus {
  tools: CodingAgentToolStatus[]
}

export interface CodingAgentMutationResult extends CodingAgentsStatus {
  success: boolean
  tool: CodingAgentToolStatus
  message?: string
  code?: string
}

export interface CodingAgentConfigFileDefinition {
  key: string
  path: string
  absolutePath: string
  language: string
}

export interface CodingAgentConfigScope {
  profile?: string
  provider?: string
}

export interface CodingAgentConfigFileContent extends CodingAgentConfigFileDefinition {
  content: string
  exists: boolean
  size: number
  profile: string
  provider: string
  rootDir: string
}

export interface CodingAgentLaunchInput extends CodingAgentConfigScope {
  agentPreset?: string
  mode?: 'scoped' | 'global'
  model?: string
  workspace?: string | null
  baseUrl?: string
  apiKey?: string
  apiMode?: ApiMode
  reasoningEffort?: string
  sessionId?: string
  agentSessionId?: string
  agentNativeSessionId?: string
  isolateSettings?: boolean
  sessionSource?: 'global_agent' | 'workflow' | 'group_chat'
  groupSystemPrompt?: string
  groupRuntimeScope?: {
    roomId: string
    agentId: string
  }
  /** Internal Pi transport: terminal launches are interactive; Studio runs use RPC. */
  piOutputMode?: 'interactive' | 'rpc'
  approveProjectConfig?: boolean
}

export interface CodingAgentLaunchResult {
  agentId: CodingAgentId
  mode: 'scoped' | 'global'
  profile: string
  provider: string
  model: string
  apiMode?: ApiMode
  rootDir: string
  workspaceDir: string
  command: string
  args: string[]
  env: Record<string, string>
  shellCommand: string
  files: Array<{ key: string; path: string; absolutePath: string }>
  promptFile?: string
  reasoningEffort?: string
}

export interface CodingAgentNativeLaunchResult extends CodingAgentLaunchResult {
  nativeTerminal: true
  terminal: string
}

export interface CodingAgentRunStartResult extends CodingAgentLaunchResult {
  agentSessionId: string
  sessionId: string
  pid: number
}

const TOOL_DEFINITIONS: CodingAgentDefinition[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    provider: 'Anthropic',
    command: 'claude',
    packageName: '@anthropic-ai/claude-code',
  },
  {
    id: 'codex',
    name: 'Codex',
    provider: 'OpenAI',
    command: 'codex',
    packageName: '@openai/codex',
  },
  {
    id: 'pi',
    name: 'Pi',
    provider: 'Pi',
    command: 'pi',
    packageName: '@earendil-works/pi-coding-agent',
  },
  GROK_CODING_AGENT_DEFINITION,
  {
    id: 'opencode',
    name: 'OpenCode',
    provider: 'OpenCode',
    command: 'opencode',
    packageName: 'opencode-ai',
  },
  {
    id: 'dsh',
    name: 'DeepSeek Harness',
    provider: 'DeepSeek',
    command: 'dsh',
    packageName: '@deepseek-ai/dsh',
  },
]

const CONFIG_FILE_DEFINITIONS: Record<CodingAgentId, Array<Omit<CodingAgentConfigFileDefinition, 'absolutePath'> & { scopedPath: string }>> = {
  'claude-code': [
    { key: 'settings', path: '~/.claude/settings.json', scopedPath: 'settings.json', language: 'json' },
    { key: 'mcp', path: '~/.claude/mcp.json', scopedPath: 'mcp.json', language: 'json' },
    { key: 'memory', path: '~/.claude/CLAUDE.md', scopedPath: 'CLAUDE.md', language: 'markdown' },
    { key: 'prompt', path: '~/.claude/hermes-rules.md', scopedPath: 'hermes-rules.md', language: 'markdown' },
  ],
  codex: [
    { key: 'auth', path: '~/.codex/auth.json', scopedPath: 'auth.json', language: 'json' },
    { key: 'config', path: '~/.codex/config.toml', scopedPath: 'config.toml', language: 'ini' },
    { key: 'agents', path: '~/.codex/AGENTS.md', scopedPath: 'AGENTS.md', language: 'markdown' },
  ],
  pi: [
    { key: 'auth', path: '~/.pi/agent/auth.json', scopedPath: 'auth.json', language: 'json' },
    { key: 'settings', path: '~/.pi/agent/settings.json', scopedPath: 'settings.json', language: 'json' },
    { key: 'agents', path: '~/.pi/agent/AGENTS.md', scopedPath: 'AGENTS.md', language: 'markdown' },
    { key: 'mcp', path: '~/.pi/agent/mcp.json', scopedPath: 'mcp.json', language: 'json' },
  ],
  grok: [
    { key: 'auth', path: '~/.grok/auth.json', scopedPath: 'auth.json', language: 'json' },
    { key: 'config', path: '~/.grok/config.toml', scopedPath: 'config.toml', language: 'ini' },
    { key: 'mcp', path: '~/.grok/config.toml', scopedPath: 'config.toml', language: 'ini' },
    { key: 'settings', path: '~/.grok/config.toml', scopedPath: 'config.toml', language: 'ini' },
    { key: 'agents', path: '~/.grok/AGENTS.md', scopedPath: 'AGENTS.md', language: 'markdown' },
  ],
  dsh: [
    { key: 'settings', path: '~/.dsh/settings.yaml', scopedPath: 'settings.yaml', language: 'yaml' },
    { key: 'memory', path: '~/.dsh/AGENTS.md', scopedPath: 'AGENTS.md', language: 'markdown' },
    { key: 'mcp', path: '~/.dsh/cordis.patch.yml', scopedPath: 'cordis.patch.yml', language: 'yaml' },
  ],
  opencode: [
    { key: 'settings', path: '~/.config/opencode/opencode.json', scopedPath: OPENCODE_CONFIG_FILE, language: 'json' },
    { key: 'memory', path: '~/.config/opencode/AGENTS.md', scopedPath: 'AGENTS.md', language: 'markdown' },
    { key: 'mcp', path: '~/.config/opencode/opencode.json', scopedPath: OPENCODE_CONFIG_FILE, language: 'json' },
    // Keep the native names as compatibility aliases for older clients.
    { key: 'config', path: '~/.config/opencode/opencode.json', scopedPath: OPENCODE_CONFIG_FILE, language: 'json' },
    { key: 'agents', path: '~/.config/opencode/AGENTS.md', scopedPath: 'AGENTS.md', language: 'markdown' },
  ],
}

const installingTools = new Set<CodingAgentId>()
const deletingTools = new Set<CodingAgentId>()
let cachedGlobalNpmBin: string | null | undefined
let cachedLoginShellPath: string | null | undefined
const MAX_CONFIG_FILE_SIZE = parseInt(process.env.MAX_EDIT_SIZE || '', 10) || 10 * 1024 * 1024

function getNodeBinDir() {
  return dirname(process.execPath)
}

function getNodePrefix() {
  return process.platform === 'win32' ? getNodeBinDir() : dirname(getNodeBinDir())
}

function getHomebrewPrefix() {
  const match = process.execPath.match(/^(.*)\/Cellar\/[^/]+\/[^/]+\/bin\/node$/)
  return match?.[1] || null
}

function getNpmCliCandidates() {
  const prefix = getNodePrefix()
  const homebrewPrefix = getHomebrewPrefix()

  return process.platform === 'win32'
    ? [
        join(prefix, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        join(getNodeBinDir(), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      ]
    : [
        join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        ...(homebrewPrefix ? [join(homebrewPrefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')] : []),
      ]
}

function getNpmCliPath() {
  return getNpmCliCandidates().find(existsSync) || null
}

function getNpmBin() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function getGlobalConfigHome() {
  return getCodingAgentGlobalHome()
}

function compareNodeVersionDesc(left: string, right: string): number {
  const leftParts = left.replace(/^v/, '').split('.').map(part => Number.parseInt(part, 10) || 0)
  const rightParts = right.replace(/^v/, '').split('.').map(part => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const diff = (rightParts[index] || 0) - (leftParts[index] || 0)
    if (diff !== 0) return diff
  }
  return right.localeCompare(left)
}

function getNvmNodeBinPaths(): string {
  if (process.env.HERMES_DESKTOP !== 'true' || process.platform === 'win32') return ''

  const nvmDir = process.env.NVM_DIR?.trim() || join(homedir(), '.nvm')
  const versionsDir = join(nvmDir, 'versions', 'node')
  if (!existsSync(versionsDir)) return ''

  try {
    return readdirSync(versionsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort(compareNodeVersionDesc)
      .map(version => join(versionsDir, version, 'bin'))
      .filter(binDir => existsSync(binDir))
      .join(delimiter)
  } catch {
    return ''
  }
}

function getLoginShellCandidates(): string[] {
  if (process.platform === 'win32') return []
  return [
    process.env.SHELL || '',
    '/bin/zsh',
    '/bin/bash',
    '/usr/bin/zsh',
    '/usr/bin/bash',
  ].filter(Boolean)
}

function getLoginShell(): string | null {
  for (const shell of [...new Set(getLoginShellCandidates())]) {
    if (shell.startsWith('/') && existsSync(shell)) return shell
  }
  return null
}

async function getLoginShellPath(): Promise<string | null> {
  if (process.env.HERMES_DESKTOP !== 'true' || process.platform === 'win32') return null
  if (typeof cachedLoginShellPath !== 'undefined') return cachedLoginShellPath

  const shell = getLoginShell()
  if (!shell) {
    cachedLoginShellPath = null
    return cachedLoginShellPath
  }

  try {
    const { stdout } = await execFileAsync(shell, ['-lc', 'printf %s "$PATH"'], {
      encoding: 'utf-8',
      timeout: 3000,
      windowsHide: true,
    })
    cachedLoginShellPath = stdout.trim() || null
  } catch {
    cachedLoginShellPath = null
  }
  return cachedLoginShellPath
}

function getDesktopCommonBinPaths(): string[] {
  if (process.env.HERMES_DESKTOP !== 'true' || process.platform === 'win32') return []
  const home = homedir()
  return [
    join(home, '.npm-global', 'bin'),
    join(home, '.local', 'bin'),
    join(home, '.yarn', 'bin'),
    join(home, '.config', 'yarn', 'global', 'node_modules', '.bin'),
    join(home, '.pnpm'),
    join(home, 'Library', 'pnpm'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]
}

function prependPathEntries(env: NodeJS.ProcessEnv, entries: Array<string | null | undefined>) {
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH'
  const currentPath = env[pathKey] || ''
  const existing = new Set(currentPath.split(delimiter).filter(Boolean))
  const prepended: string[] = []

  for (const entry of entries) {
    if (!entry) continue
    for (const segment of entry.split(delimiter).map(item => item.trim()).filter(Boolean)) {
      if (existing.has(segment) || prepended.includes(segment)) continue
      prepended.push(segment)
    }
  }

  if (prepended.length > 0) {
    env[pathKey] = currentPath ? `${prepended.join(delimiter)}${delimiter}${currentPath}` : prepended.join(delimiter)
  }
}

function nodeEnvironmentMissingError(): Error {
  const err = new Error('Node/npm environment was not detected. Please install Node.js and try again.')
  ;(err as any).code = NODE_ENVIRONMENT_MISSING_CODE
  return err
}

function isNodeEnvironmentMissingError(err: any): boolean {
  const text = [
    err?.code,
    err?.message,
    typeof err?.stderr === 'string' ? err.stderr : '',
    typeof err?.stdout === 'string' ? err.stdout : '',
  ].filter(Boolean).join('\n').toLowerCase()
  return text.includes('enoent') ||
    text.includes('spawn npm') ||
    text.includes('npm: command not found') ||
    text.includes('npm not found') ||
    text.includes('node: command not found') ||
    text.includes('node not found')
}

function npmCliFromNpmBin(npmBin: string): { node: string; npmCli: string } | null {
  const binDir = dirname(npmBin)
  if (process.platform === 'win32') {
    const node = join(binDir, 'node.exe')
    const npmCli = join(binDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    return existsSync(node) && existsSync(npmCli) ? { node, npmCli } : null
  }

  const node = join(binDir, 'node')
  const npmCli = join(dirname(binDir), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return existsSync(node) && existsSync(npmCli) ? { node, npmCli } : null
}

function normalizeScopeSegment(value: string | undefined, fallback: string, label: string): string {
  // Replace invalid filename characters with underscores
  // Windows invalid chars: < > : " / \ | ? *
  // Additional problematic chars: control characters
  const sanitizedValue = String(value || '').trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
  const segment = sanitizedValue || fallback

  if (
    segment === '.' ||
    segment === '..' ||
    segment.includes('\0')
  ) {
    const err = new Error(`Invalid ${label}`)
    ;(err as any).status = 400
    throw err
  }
  if (segment.length > 128) {
    const err = new Error(`${label} is too long`)
    ;(err as any).status = 400
    throw err
  }
  return segment
}

function normalizeProviderIdentity(value: string | undefined): string {
  const provider = String(value || '').trim() || 'default'
  if (/[\x00-\x1f\x7f-\x9f]/.test(provider)) {
    const err = new Error('Invalid provider')
    ;(err as any).status = 400
    throw err
  }
  if (provider.length > 128) {
    const err = new Error('provider is too long')
    ;(err as any).status = 400
    throw err
  }
  return provider
}

function normalizeConfigScope(scope: CodingAgentConfigScope = {}): Required<CodingAgentConfigScope> {
  return {
    profile: normalizeScopeSegment(scope.profile, 'default', 'profile'),
    provider: normalizeScopeSegment(scope.provider, 'default', 'provider'),
  }
}

function slugProviderName(value: string): string {
  return String(value || '').trim().toLowerCase().replace(/ /g, '-')
}

function providerKeyWithoutCustomPrefix(providerKey: string): string {
  if (providerKey.startsWith('custom:')) return providerKey.slice('custom:'.length)
  if (providerKey.startsWith('custom_')) return providerKey.slice('custom_'.length)
  return providerKey
}

function providerLookupCandidates(provider: string): string[] {
  const trimmed = String(provider || '').trim()
  const withoutCustom = providerKeyWithoutCustomPrefix(trimmed)
  return [...new Set([
    trimmed,
    withoutCustom,
    withoutCustom ? `custom:${withoutCustom}` : '',
    withoutCustom ? `custom_${withoutCustom}` : '',
  ].filter(Boolean))]
}

function parseEnvValue(envContent: string, key: string): string {
  if (!key) return ''
  const lines = envContent.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue
    if (trimmed.slice(0, eqIndex).trim() !== key) continue
    const raw = trimmed.slice(eqIndex + 1).trim()
    if (
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
    ) {
      return raw.slice(1, -1)
    }
    return raw
  }
  return ''
}

function inferLaunchApiMode(provider: string, baseUrl: string, fallback: ApiMode = 'chat_completions'): ApiMode {
  const providerKey = String(provider || '').toLowerCase()
  const normalizedBaseUrl = String(baseUrl || '').toLowerCase()
  if (
    providerKey.includes('claude') ||
    providerKey === 'anthropic' ||
    normalizedBaseUrl.includes('anthropic') ||
    normalizedBaseUrl.includes('/anthropic')
  ) {
    return 'anthropic_messages'
  }
  if (
    providerKey === 'deepseek' ||
    providerKey === 'lmstudio' ||
    normalizedBaseUrl.includes('deepseek') ||
    normalizedBaseUrl.includes('127.0.0.1') ||
    normalizedBaseUrl.includes('localhost')
  ) {
    return 'chat_completions'
  }
  return fallback
}

function providerPresetHost(value?: string): string {
  const url = String(value || '').trim()
  if (!url) return ''
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function belongsToDifferentBuiltinProvider(provider: string, baseUrl: string): boolean {
  const providerKey = providerKeyWithoutCustomPrefix(String(provider || '').trim().toLowerCase())
  if (!providerKey || provider !== providerKey) return false
  const currentPreset = PROVIDER_PRESETS.find(item => item.value === providerKey)
  if (!currentPreset) return false
  const inputHost = providerPresetHost(baseUrl)
  const currentHost = providerPresetHost(currentPreset.base_url)
  if (!inputHost || !currentHost || inputHost === currentHost) return false
  return PROVIDER_PRESETS.some((item) => (
    item.value !== providerKey &&
    providerPresetHost(item.base_url) === inputHost
  ))
}

async function resolveStoredProviderLaunchInput(
  input: CodingAgentLaunchInput & { sessionId: string },
  existingSession: HermesSessionRow | null,
): Promise<CodingAgentLaunchInput & { sessionId: string }> {
  if (input.mode === 'global') return input

  const profile = String(input.profile || existingSession?.profile || 'default').trim() || 'default'
  const inputProvider = String(input.provider || '').trim()
  const storedProvider = String(existingSession?.provider || '').trim()
  const provider = String(inputProvider || storedProvider).trim()
  const model = String(input.model || existingSession?.model || '').trim()
  const workspace = input.workspace || existingSession?.workspace || undefined
  let baseUrl = String(input.baseUrl || '').trim()
  let apiKey = String(input.apiKey || '').trim()
  const storedApiMode = !inputProvider || inputProvider === storedProvider
    ? normalizeStoredLaunchApiMode(existingSession?.api_mode)
    : undefined
  let apiMode = input.apiMode || storedApiMode
  if (provider === OPENCODE_FREE_PROVIDER) {
    return { ...input, profile, provider, model, workspace, ...openCodeFreeRuntime(model) }
  }
  let canonicalProvider = provider
  const ignoredStaleProviderRuntime = belongsToDifferentBuiltinProvider(provider, baseUrl)
  if (ignoredStaleProviderRuntime) {
    baseUrl = ''
    apiKey = ''
  }

  if (!provider || (baseUrl && apiKey && apiMode)) {
    return { ...input, profile, provider: provider || input.provider, model: model || input.model, workspace, baseUrl, apiKey, apiMode }
  }

  let config: Record<string, any> = {}
  try {
    config = await readConfigYamlForProfile(profile)
  } catch {}
  const envContent = await safeReadFile(join(getProfileDir(profile), '.env')) || ''
  const normalizedProvider = providerKeyWithoutCustomPrefix(provider)
  const preset = PROVIDER_PRESETS.find(item => item.value === normalizedProvider)
  const candidates = providerLookupCandidates(provider)

  const customProviders = getCompatibleCustomProviders(config)
  const customEntry = customProviders.find((entry) => {
    const name = slugProviderName(String(entry?.name || ''))
    return candidates.includes(`custom:${name}`) || candidates.includes(`custom_${name}`) || candidates.includes(name)
  })
  if (customEntry) {
    canonicalProvider = `custom:${slugProviderName(String(customEntry.name || normalizedProvider))}`
    if (!baseUrl) baseUrl = String(customEntry.base_url || '').trim()
    if (!apiKey) apiKey = String(customEntry.api_key || '').trim()
    if (!apiKey) {
      const keyEnv = String(customEntry.key_env || '').trim()
      if (keyEnv) apiKey = parseEnvValue(envContent, keyEnv)
    }
    if (!apiMode) {
      apiMode = normalizeLaunchApiMode(
        customEntry.api_mode,
        preset?.api_mode || inferLaunchApiMode(canonicalProvider, baseUrl, 'chat_completions'),
      )
    }
  }

  const canonicalProviderKey = providerKeyWithoutCustomPrefix(canonicalProvider)
  const canonicalPreset = PROVIDER_PRESETS.find(item => item.value === canonicalProviderKey) || preset
  const envMapping = PROVIDER_ENV_MAP[canonicalProviderKey]
  if (!baseUrl) {
    baseUrl = envMapping?.base_url_env
      ? parseEnvValue(envContent, envMapping.base_url_env) || canonicalPreset?.base_url || ''
      : canonicalPreset?.base_url || ''
  }
  if (!apiKey && envMapping?.api_key_env) {
    apiKey = parseEnvValue(envContent, envMapping.api_key_env)
  }
  if (!apiMode) {
    apiMode = normalizeLaunchApiMode(
      canonicalPreset?.api_mode,
      inferLaunchApiMode(canonicalProvider, baseUrl, 'chat_completions'),
    )
  }

  return {
    ...input,
    profile,
    provider: canonicalProvider,
    model: model || input.model,
    workspace,
    baseUrl: baseUrl || (ignoredStaleProviderRuntime ? '' : input.baseUrl),
    apiKey: apiKey || (ignoredStaleProviderRuntime ? '' : input.apiKey),
    apiMode,
  }
}

function normalizeStoredLaunchApiMode(value: unknown): ApiMode | undefined {
  if (!value) return undefined
  try {
    return normalizeLaunchApiMode(value, 'chat_completions')
  } catch {
    return undefined
  }
}

function normalizeLaunchApiMode(value: unknown, fallback: ApiMode): ApiMode {
  if (!value) return fallback
  const mode = String(value).trim() as ApiMode
  if (LAUNCH_API_MODES.has(mode)) return mode
  if (mode === 'codex_app_server') return 'codex_responses'

  const err = new Error('Invalid API protocol')
  ;(err as any).status = 400
  throw err
}

function storedCodingAgentMode(session: HermesSessionRow | null): 'scoped' | 'global' {
  if (session?.agent_mode === 'global' || session?.agent_mode === 'scoped') return session.agent_mode
  return session?.provider === 'global' ? 'global' : 'scoped'
}

function persistedAgentId(id: string): 'claude' | 'codex' | 'pi' | 'grok' | 'opencode' | 'dsh' {
  if (id === 'codex') return 'codex'
  if (id === 'pi') return 'pi'
  if (id === 'grok') return 'grok'
  if (id === 'dsh') return 'dsh'
  if (id === 'opencode') return 'opencode'
  return 'claude'
}

function makeAgentSessionId(): string {
  return `coding_agent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function getScopedConfigRoot(id: CodingAgentId, scope: Required<CodingAgentConfigScope>): string {
  return join(getWebUiHome(), CODING_AGENT_HOME_DIR, 'model', scope.profile, scope.provider, id)
}

function getScopedRuntimeConfigRoot(
  id: CodingAgentId,
  scope: Required<CodingAgentConfigScope>,
  input: Pick<CodingAgentLaunchInput, 'sessionId' | 'agentSessionId' | 'groupRuntimeScope'>,
): string {
  const groupRoomId = String(input.groupRuntimeScope?.roomId || '').trim()
  const groupAgentId = String(input.groupRuntimeScope?.agentId || '').trim()
  if (groupRoomId && groupAgentId) {
    const stableSegment = (value: string) => {
      const readable = value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'scope'
      const digest = createHash('sha256').update(value).digest('hex').slice(0, 12)
      return `${readable}_${digest}`
    }
    return join(
      getScopedConfigRoot(id, scope),
      'group-chat',
      stableSegment(groupRoomId),
      stableSegment(groupAgentId),
    )
  }
  const rootDir = getScopedConfigRoot(id, scope)
  const sessionId = String(input.sessionId || '').trim()
  const agentSessionId = String(input.agentSessionId || '').trim()
  if ((!sessionId || !agentSessionId) && (id === 'pi' || id === 'dsh')) {
    const runtimeKey = createHash('sha256')
      .update(JSON.stringify([
        sessionId || randomUUID(),
        agentSessionId || randomUUID(),
        process.pid,
        Date.now(),
      ]))
      .digest('hex')
    return join(rootDir, 'runs', runtimeKey)
  }
  if (!sessionId || !agentSessionId) return rootDir
  const runtimeKey = createHash('sha256')
    .update(JSON.stringify([sessionId, agentSessionId]))
    .digest('hex')
  return join(rootDir, 'runs', runtimeKey)
}

function getScopedWorkspaceRoot(scope: Required<CodingAgentConfigScope>): string {
  return defaultCodingAgentWorkspace(scope.profile, scope.provider)
}

function resolveLaunchWorkspaceRoot(scope: Required<CodingAgentConfigScope>, workspace?: string | null): string {
  const customWorkspace = String(workspace || '').trim()
  if (customWorkspace) {
    if (customWorkspace.includes('\0')) {
      const err = new Error('Invalid workspace')
      ;(err as any).status = 400
      throw err
    }
    return customWorkspace
  }
  return getScopedWorkspaceRoot(scope)
}

function displayNameForModel(model: string): string {
  const trimmed = model.trim()
  if (!trimmed) return 'Model'
  const leaf = trimmed.split('/').filter(Boolean).pop() || trimmed
  return leaf
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase())
}

function codexCatalogEntry(input: {
  model: string
  displayName: string
  contextWindow: number
  priority: number
}) {
  return {
    slug: input.model,
    display_name: input.displayName,
    description: input.displayName,
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [
      { effort: 'none', description: 'Disable provider-side reasoning when supported' },
      { effort: 'minimal', description: 'Use the smallest provider-side reasoning budget when supported' },
      { effort: 'low', description: 'Fast responses with lighter reasoning' },
      { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
      { effort: 'high', description: 'Greater reasoning depth for complex problems' },
      { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
      { effort: 'max', description: 'Maximum reasoning depth for the hardest quality-first tasks' },
    ],
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: 1000 + input.priority,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    availability_nux: null,
    upgrade: null,
    base_instructions: CODEX_CATALOG_BASE_INSTRUCTIONS,
    model_messages: {
      instructions_template: '{{ base_instructions }}\n\n{{ personality }}',
      instructions_variables: {
        base_instructions: CODEX_CATALOG_BASE_INSTRUCTIONS,
        personality: '',
        personality_default: '',
        personality_friendly: '',
        personality_pragmatic: '',
      },
    },
    supports_reasoning_summaries: true,
    default_reasoning_summary: 'auto',
    support_verbosity: true,
    default_verbosity: 'low',
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text_and_image',
    truncation_policy: { mode: 'tokens', limit: 10_000 },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: true,
    context_window: input.contextWindow,
    max_context_window: input.contextWindow,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ['text', 'image'],
    supports_search_tool: true,
  }
}

function buildCodexModelCatalog(input: {
  profile: string
  provider: string
  model: string
  presetModels: string[]
}) {
  const models = [...new Set([input.model, ...input.presetModels].map(item => item.trim()).filter(Boolean))]
  return {
    models: models.map((model, index) => codexCatalogEntry({
      model,
      displayName: displayNameForModel(model),
      contextWindow: getModelContextLength({ profile: input.profile, provider: input.provider, model }),
      priority: index,
    })),
  }
}

function hasRootPrivileges(): boolean {
  if (process.platform === 'win32') return false
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  const euid = typeof process.geteuid === 'function' ? process.geteuid() : null
  return uid === 0 || euid === 0
}

function claudeCodePermissionArgs(): string[] {
  return hasRootPrivileges() ? CLAUDE_CODE_ROOT_PERMISSION_ARGS : CLAUDE_CODE_SKIP_PERMISSIONS_ARGS
}

function expandHomePath(path: string): string {
  if (path === '~') return getGlobalConfigHome()
  if (path.startsWith('~/')) return join(getGlobalConfigHome(), path.slice(2))
  return path
}

function getGlobalCodexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(getGlobalConfigHome(), '.codex')
}

function shouldCopyGlobalCodexFile(name: string): boolean {
  if (name === 'AGENTS.md' || name === 'AGENTS.override.md') return false
  if (name === 'history.jsonl' || name === 'session_index.jsonl' || name === 'transcription-history.jsonl') return false
  if (name === 'codex-tui.log' || name.startsWith('.codex-global-state')) return false
  if (name.endsWith('.sqlite') || name.endsWith('.sqlite-shm') || name.endsWith('.sqlite-wal')) return false
  return true
}

async function pathEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (err: any) {
    if (err?.code === 'ENOENT') return false
    throw err
  }
}

async function linkGlobalCodexDirectory(source: string, target: string): Promise<void> {
  if (await pathEntryExists(target)) return
  try {
    await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (err: any) {
    if (err?.code !== 'EEXIST' && err?.code !== 'EPERM' && err?.code !== 'ENOTSUP') throw err
  }
}

async function activeGlobalCodexInstructions(sourceHome: string): Promise<string> {
  const override = await safeReadFile(join(sourceHome, 'AGENTS.override.md')) || ''
  if (override.trim()) return override
  return await safeReadFile(join(sourceHome, 'AGENTS.md')) || ''
}

async function prepareGlobalCodexShadowHome(rootDir: string, systemPrompt: string, profile: string): Promise<string> {
  const sourceHome = getGlobalCodexHome()
  await mkdir(rootDir, { recursive: true, mode: 0o700 })

  if (sourceHome !== rootDir && existsSync(sourceHome)) {
    const entries = await readdir(sourceHome, { withFileTypes: true })
    for (const entry of entries) {
      const source = join(sourceHome, entry.name)
      const target = join(rootDir, entry.name)
      if (entry.isFile() && shouldCopyGlobalCodexFile(entry.name)) {
        await copyFile(source, target)
      } else if (entry.isDirectory() && GLOBAL_CODEX_SHADOW_LINK_DIRS.has(entry.name)) {
        await linkGlobalCodexDirectory(source, target)
      }
    }
  }

  const config = parseToml(await safeReadFile(join(sourceHome, 'config.toml')) || '')
  const externalMcp = { ...(config.mcp_servers as Record<string, any> || {}) }
  for (const [name, server] of Object.entries(externalMcp)) {
    if (HERMES_MCP_SERVER_NAMES.has(name) || LEGACY_HERMES_MCP_SERVER_NAMES.has(name)
      || server?.env?.[HERMES_MCP_MANAGED_ENV_KEY]) delete externalMcp[name]
  }
  config.mcp_servers = { ...externalMcp, ...getCodingAgentManagedMcpServerConfigs('codex', profile) } as any
  await writeFile(join(rootDir, 'config.toml'), stringifyToml(config), { mode: 0o600 })

  const promptPath = join(rootDir, 'AGENTS.md')
  await writeManagedPromptFile(promptPath, systemPrompt, await activeGlobalCodexInstructions(sourceHome))
  return promptPath
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function powerShellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function tomlMultilineString(value: string): string {
  const normalized = String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\\/g, '\\\\')
    .replace(/"""/g, '\\"\\"\\"')
  return `"""\n${normalized}\n"""`
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`
}

function tomlInlineStringTable(values: Record<string, string>): string {
  return `{ ${Object.entries(values).map(([key, value]) => `${key} = ${tomlString(value)}`).join(', ')} }`
}

function isDesktopRuntime(): boolean {
  return String(process.env.HERMES_DESKTOP || '').trim().toLowerCase() === 'true'
}

function candidateBundledMcpScripts(): string[] {
  return [
    process.env.HERMES_WEB_UI_MCP_BIN,
    join(process.cwd(), 'bin/ekko-studio-mcp.mjs'),
    join(__dirname, '../../bin/ekko-studio-mcp.mjs'),
    join(__dirname, '../../../../../../bin/ekko-studio-mcp.mjs'),
    join(__dirname, '../../../../../bin/ekko-studio-mcp.mjs'),
    join(process.cwd(), 'bin/hermes-web-ui-mcp.mjs'),
    join(__dirname, '../../bin/hermes-web-ui-mcp.mjs'),
    join(__dirname, '../../../../../../bin/hermes-web-ui-mcp.mjs'),
    join(__dirname, '../../../../../bin/hermes-web-ui-mcp.mjs'),
  ].filter((value): value is string => !!value)
}

function bundledMcpScriptPath(): string | null {
  return candidateBundledMcpScripts().find(candidate => existsSync(candidate)) || null
}

function runtimeNodePath(): string | null {
  const node = process.env.HERMES_AGENT_NODE?.trim()
  return node || null
}

function hermesMcpCommandConfig(toolset: string): { command: string; args?: string[] } {
  const script = bundledMcpScriptPath()
  if (script) return { command: runtimeNodePath() || process.execPath, args: [script, toolset] }
  if (isDesktopRuntime()) return { command: 'ekko-studio-mcp', args: [toolset] }
  return { command: 'ekko-studio-mcp', args: [toolset] }
}

function hermesMcpServerConfig(profile: string, serverName: string, toolset: string): { command: string; args?: string[]; env: Record<string, string> } {
  const appHome = getWebUiHome()
  return {
    ...hermesMcpCommandConfig(toolset),
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      HERMES_WEB_UI_URL: `http://127.0.0.1:${process.env.PORT || '8648'}`,
      HERMES_WEB_UI_HOME: appHome,
      HERMES_WEBUI_STATE_DIR: appHome,
      HERMES_WEB_UI_PROFILE: profile,
      HERMES_MCP_SERVER_NAME: serverName,
      HERMES_MCP_TOOLSET: toolset,
      HERMES_MCP_USER_CLARIFICATION: '1',
      [HERMES_MCP_MANAGED_ENV_KEY]: '1',
    },
  }
}

function managedHermesMcpServerConfig(
  agentId: CodingAgentId,
  profile: string,
  serverName: string,
  toolset: string,
): Record<string, unknown> {
  const override = getManagedMcpServerOverride(agentId, profile, serverName)
  const server: Record<string, unknown> = Object.keys(override).length
    ? override
    : hermesMcpServerConfig(profile, serverName, toolset)
  if (toolset === 'plan') {
    const env = server.env as Record<string, string> | undefined
    if (env?.[HERMES_MCP_MANAGED_ENV_KEY] === '1') {
      server.env = { ...env, HERMES_MCP_SERVER_NAME: serverName, HERMES_MCP_USER_CLARIFICATION: '1' }
    }
    if (agentId === 'claude-code' || agentId === 'opencode') server.timeout = Math.max(360_000, Number(server.timeout) || 0)
    if (agentId === 'dsh') server.toolCallTimeoutMs = Math.max(360_000, Number(server.toolCallTimeoutMs) || 0)
  }
  return server
}

function isManagedHermesMcpServer(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const server = value as Record<string, any>
  if (server.env && typeof server.env === 'object' && server.env[HERMES_MCP_MANAGED_ENV_KEY] === '1') return true
  return typeof server.command === 'string' && LEGACY_HERMES_MCP_COMMANDS.has(server.command)
}

function normalizeClaudeMcpServer(server: unknown): unknown {
  if (!server || typeof server !== 'object' || Array.isArray(server)) return server
  const normalized = { ...(server as Record<string, unknown>) }
  delete normalized.enabled
  if (normalized.type === 'streamableHttp') normalized.type = 'http'
  return normalized
}

function parseClaudeMcpServers(existingContent: string | null | undefined = ''): Record<string, unknown> {
  if (!existingContent?.trim()) return {}
  try {
    const parsed = JSON.parse(existingContent)
    if (!parsed?.mcpServers || typeof parsed.mcpServers !== 'object' || Array.isArray(parsed.mcpServers)) return {}
    return Object.fromEntries(Object.entries(parsed.mcpServers)
      .filter(([name, server]) => {
        if (HERMES_MCP_SERVER_NAMES.has(name)) return false
        if (LEGACY_HERMES_MCP_SERVER_NAMES.has(name)) return false
        if (server && typeof server === 'object' && !Array.isArray(server)
          && (server as Record<string, unknown>).enabled === false) return false
        return !isManagedHermesMcpServer(server)
      })
      .map(([name, server]) => [name, normalizeClaudeMcpServer(server)]))
  } catch {
    return {}
  }
}

function inheritClaudeSettings(existingContent: string | null | undefined = ''): Record<string, unknown> {
  if (!existingContent?.trim()) return {}
  try {
    const parsed = JSON.parse(existingContent)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const inherited = { ...parsed } as Record<string, unknown>
    // Scoped Coding Agent runs authenticate exclusively through the selected
    // Ekko Studio profile proxy. Never inherit native Claude login/provider
    // routing, otherwise a stale OAuth session can override the profile.
    delete inherited.apiKeyHelper
    delete inherited.awsAuthRefresh
    delete inherited.awsCredentialExport
    delete inherited.forceLoginMethod
    if (inherited.env && typeof inherited.env === 'object' && !Array.isArray(inherited.env)) {
      inherited.env = Object.fromEntries(
        Object.entries(inherited.env as Record<string, unknown>)
          .filter(([key, value]) => typeof value === 'string' && !(
              key.startsWith('ANTHROPIC_')
              || key === 'CLAUDE_CODE_OAUTH_TOKEN'
              || key === 'CLAUDE_CODE_USE_BEDROCK'
              || key === 'CLAUDE_CODE_USE_VERTEX'
              || key === 'CLAUDE_CODE_USE_FOUNDRY'
            )),
      )
    }
    return inherited
  } catch {
    return {}
  }
}

function claudeMcpConfigJson(profile: string, ...existingContents: Array<string | null | undefined>): string {
  const mcpServers: Record<string, unknown> = {}
  for (const content of existingContents) {
    Object.assign(mcpServers, parseClaudeMcpServers(content))
  }
  for (const server of HERMES_MCP_SERVERS) {
    if (getDisabledManagedMcpServers('claude-code', profile).has(server.name)) continue
    const config = managedHermesMcpServerConfig('claude-code', profile, server.name, server.toolset)
    mcpServers[server.name] = config
  }
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`
}

function parseCodexExternalMcpBlocks(...contents: Array<string | null | undefined>): string[] {
  const blockByServer = new Map<string, string>()

  for (const content of contents) {
    if (!content?.trim()) continue
    let currentServer = ''
    let currentLines: string[] = []
    const flush = () => {
      if (!currentServer || currentLines.length === 0) return
      const block = currentLines.join('\n').trim()
      const isManaged = block.includes(`${HERMES_MCP_MANAGED_ENV_KEY}`)
      if (!HERMES_MCP_SERVER_NAMES.has(currentServer) && !LEGACY_HERMES_MCP_SERVER_NAMES.has(currentServer) && !isManaged) {
        blockByServer.set(currentServer, block)
      }
    }

    for (const line of content.split(/\r?\n/)) {
      const mcpMatch = line.match(/^\s*\[mcp_servers\.([^\].]+)(\.[^\]]+)?\]\s*$/)
      if (mcpMatch) {
        const nextServer = mcpMatch[1]
        const isSubtable = Boolean(mcpMatch[2])
        if (currentServer && nextServer === currentServer && isSubtable) {
          currentLines.push(line)
          continue
        }
        flush()
        currentServer = nextServer
        currentLines = [line]
        continue
      }
      if (/^\s*\[/.test(line)) {
        flush()
        currentServer = ''
        currentLines = []
        continue
      }
      if (currentServer) currentLines.push(line)
    }
    flush()
  }

  return Array.from(blockByServer.values()).filter(Boolean)
}

interface TomlArrayScanState {
  quote: '"' | "'" | null
  multiline: boolean
}

function scanTomlArrayBrackets(line: string, state: TomlArrayScanState): number {
  let delta = 0
  let escaped = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (state.quote) {
      if (state.multiline) {
        if (state.quote === '"' && char === '\\') {
          escaped = !escaped
          continue
        }
        if (char === state.quote && !escaped) {
          let quoteCount = 1
          while (line[index + quoteCount] === state.quote) quoteCount += 1
          if (quoteCount >= 3) {
            state.quote = null
            state.multiline = false
            index += quoteCount - 1
          }
        }
        escaped = false
        continue
      }
      if (state.quote === '"' && char === '\\' && !escaped) {
        escaped = true
        continue
      }
      if (char === state.quote && !escaped) {
        state.quote = null
      }
      escaped = false
      continue
    }
    if (char === '#') break
    if (char === '"' || char === "'") {
      state.quote = char
      state.multiline = line.slice(index, index + 3) === char.repeat(3)
      if (state.multiline) index += 2
      continue
    }
    if (char === '[') delta += 1
    else if (char === ']') delta -= 1
  }
  return delta
}

function isManagedCodexSection(section: string): boolean {
  return section === 'models'
    || section.startsWith('model.')
    || section.startsWith('model_providers.')
    || section.startsWith('mcp_servers.')
    || section === 'auth'
    || section.startsWith('auth.')
    || section === 'account'
    || section.startsWith('account.')
}

function codexRuntimeUserConfig(...contents: Array<string | null | undefined>): {
  topLevelLines: string[]
  sectionBlocks: string[]
  featureLines: string[]
} {
  const topLevel = new Map<string, string>()
  const sections = new Map<string, { header: string; lines: string[] }>()
  const featureLines = new Map<string, string>()
  const runtimeKeys = new Set([
    'model',
    'model_provider',
    'model_catalog_json',
    'model_reasoning_summary',
    'model_reasoning_effort',
    'developer_instructions',
    'disable_response_storage',
    'experimental_bearer_token',
    'forced_login_method',
    'preferred_auth_method',
    'chatgpt_base_url',
  ])
  const runtimeFeatures = new Set(['tool_search', 'tool_search_always_defer_mcp_tools'])

  let arraySectionIndex = 0
  for (const content of contents) {
    if (!content?.trim()) continue
    let section = ''
    let sectionKey = ''
    const sectionScanState: TomlArrayScanState = { quote: null, multiline: false }
    const lines = content.split(/\r?\n/)
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex]
      if (sectionScanState.multiline) {
        const sectionBlock = sections.get(sectionKey)
        if (sectionBlock && section !== 'features' && !isManagedCodexSection(section)) {
          sectionBlock.lines.push(line)
        }
        scanTomlArrayBrackets(line, sectionScanState)
        continue
      }
      const arrayHeader = line.match(/^\s*\[\[([^\]]+)\]\]\s*$/)
      if (arrayHeader) {
        section = arrayHeader[1].trim()
        sectionKey = `array:${arraySectionIndex++}`
        sections.set(sectionKey, { header: line.trim(), lines: [] })
        continue
      }
      const tableHeader = line.match(/^\s*\[([^\]]+)\]\s*$/)
      if (tableHeader) {
        section = tableHeader[1].trim()
        sectionKey = `table:${section}`
        if (!sections.has(sectionKey)) sections.set(sectionKey, { header: line.trim(), lines: [] })
        continue
      }
      const assignment = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/)
      if (!section) {
        if (assignment && !runtimeKeys.has(assignment[1])) {
          let mergedLine = line
          const scanState: TomlArrayScanState = { quote: null, multiline: false }
          let bracketDepth = scanTomlArrayBrackets(line.slice(line.indexOf('=') + 1), scanState)
          while ((bracketDepth > 0 || scanState.multiline) && lineIndex + 1 < lines.length) {
            lineIndex += 1
            const nextLine = lines[lineIndex]
            mergedLine += `\n${nextLine}`
            bracketDepth += scanTomlArrayBrackets(nextLine, scanState)
          }
          topLevel.set(assignment[1], mergedLine)
        }
        continue
      }
      if (section === 'features') {
        if (assignment && !runtimeFeatures.has(assignment[1])) featureLines.set(assignment[1], line)
        scanTomlArrayBrackets(line, sectionScanState)
        continue
      }
      if (isManagedCodexSection(section)) {
        scanTomlArrayBrackets(line, sectionScanState)
        continue
      }
      const sectionBlock = sections.get(sectionKey)
      if (sectionBlock && line.trim()) sectionBlock.lines.push(line)
      scanTomlArrayBrackets(line, sectionScanState)
    }
  }

  const sectionBlocks: string[] = []
  for (const [key, { header, lines }] of sections) {
    if (lines.length || key.startsWith('array:')) {
      sectionBlocks.push(lines.length ? `${header}\n${lines.join('\n')}` : header)
    }
  }
  return {
    topLevelLines: [...topLevel.values()],
    sectionBlocks,
    featureLines: [...featureLines.values()],
  }
}

function codexMcpConfigToml(
  profile: string,
  agentId: 'codex' | 'grok',
  ...externalContents: Array<string | null | undefined>
): string {
  const blocks: string[] = [...parseCodexExternalMcpBlocks(...externalContents)]
  const disabledManaged = getDisabledManagedMcpServers(agentId, profile)
  for (const item of HERMES_MCP_SERVERS) {
    const server = managedHermesMcpServerConfig(agentId, profile, item.name, item.toolset)
    const lines = [
      `[mcp_servers.${item.name}]`,
    ]
    if (typeof server.command === 'string' && server.command) lines.push(`command = ${tomlString(server.command)}`)
    if (typeof server.url === 'string' && server.url) lines.push(`url = ${tomlString(server.url)}`)
    if (Array.isArray(server.args) && server.args.length) lines.push(`args = ${tomlStringArray(server.args.map(String))}`)
    if (disabledManaged.has(item.name)) lines.push('enabled = false')
    lines.push(`startup_timeout_sec = ${typeof server.startup_timeout_sec === 'number' ? server.startup_timeout_sec : 120}`)
    if (item.toolset === 'use' || item.toolset === 'plan') lines.push(`tool_timeout_sec = ${Math.max(360, Number(server.tool_timeout_sec) || 0)}`)
    if (server.env && typeof server.env === 'object' && !Array.isArray(server.env)) {
      lines.push(`env = ${tomlInlineStringTable(server.env as Record<string, string>)}`)
    }
    lines.push('')
    blocks.push(lines.join('\n'))
  }
  return blocks.join('\n')
}

function getPiMcpAdapterRoot(): string {
  return join(getWebUiHome(), CODING_AGENT_HOME_DIR, 'pi-mcp-adapter')
}

function getPiMcpAdapterEntry(): string {
  return join(getPiMcpAdapterRoot(), 'node_modules', 'pi-mcp-adapter', 'index.ts')
}

const piAdapterInstalls = new Map<string, Promise<void>>()

async function installBundledPiMcpAdapter(): Promise<void> {
  const root = getPiMcpAdapterRoot()
  const pending = piAdapterInstalls.get(root)
  if (pending) return pending
  const installation = (async () => {
    const env = await commandEnv()
    await mkdir(root, { recursive: true })
    await runNpm(piMcpAdapterInstallArgs(root), { timeout: 10 * 60 * 1000, env })
  })()
  piAdapterInstalls.set(root, installation)
  try {
    await installation
  } finally {
    piAdapterInstalls.delete(root)
  }
}

async function readPiSettings(scope?: Required<CodingAgentConfigScope>): Promise<Record<string, unknown>> {
  const definitions = [
    getLiveConfigFileDefinition('pi', 'settings'),
    ...(scope ? [getScopedConfigFileDefinition('pi', 'settings', scope)] : []),
  ].filter((definition): definition is NonNullable<typeof definition> => Boolean(definition))
  const sources = await Promise.all(definitions.map(async definition => ({
    content: (await safeReadFile(definition.absolutePath)) || '',
    baseDir: dirname(definition.absolutePath),
  })))
  return mergePiSettings(sources, getPiMcpAdapterEntry())
}

function piSettingsConfig(existing: Record<string, unknown> = {}, runtimeExtensionPath = ''): string {
  const bundledAdapterEntry = getPiMcpAdapterEntry()
  const configuredExtensions = Array.isArray(existing.extensions)
    ? existing.extensions.filter(value => typeof value === 'string' && value.trim() && value !== bundledAdapterEntry)
    : []
  const extensions = new Set<string>(configuredExtensions)
  if (!userSettingsProvidesPiMcpAdapter({ ...existing, extensions: configuredExtensions })) extensions.add(bundledAdapterEntry)
  if (runtimeExtensionPath) extensions.add(runtimeExtensionPath)
  return `${JSON.stringify({
    ...existing,
    defaultProjectTrust: 'never',
    enableSkillCommands: true,
    extensions: [...extensions],
  }, null, 2)}\n`
}

function piStudioRuntimeExtension(): string {
  return [
    'import { readFileSync } from "node:fs";',
    '',
    'export default function hermesStudioRuntime(pi: any) {',
    '  pi.on("before_agent_start", async (event: any) => {',
    '    const path = String(process.env.HERMES_PI_DYNAMIC_PROMPT_FILE || "").trim();',
    '    if (!path) return;',
    '    let instructions = "";',
    '    try { instructions = readFileSync(path, "utf8").trim(); } catch {}',
    '    if (!instructions) return;',
    '    return { systemPrompt: `${event.systemPrompt}\\n\\n${instructions}` };',
    '  });',
    '}',
    '',
  ].join('\n')
}

async function prepareGlobalPiMcp(rootDir: string, profile: string) {
  const settings = await readPiSettings()
  const userProvidesAdapter = userSettingsProvidesPiMcpAdapter(settings)
  if (!userProvidesAdapter && !existsSync(getPiMcpAdapterEntry())) await installBundledPiMcpAdapter()
  const mcpPath = join(rootDir, 'mcp.json')
  await writeFile(mcpPath, piMcpConfig(profile,
    await safeReadFile(getLiveConfigFileDefinition('pi', 'mcp')?.absolutePath || ''),
  ), { mode: 0o600 })
  return {
    file: { key: 'mcp', path: 'mcp.json', absolutePath: mcpPath },
    args: [
      ...(!userProvidesAdapter ? ['--extension', getPiMcpAdapterEntry()] : []),
      '--mcp-config', mcpPath,
    ],
  }
}

const PI_RUNTIME_MCP_SETTINGS: Record<string, unknown> = {
  hostConfigDiscovery: 'off',
  toolPrefix: 'none',
  directTools: false,
  scriptMode: false,
  outputGuard: true,
  showStatusIcon: false,
  mcpFooterStatus: 'off',
  requestTimeoutMs: 120_000,
}

function parsePiExternalMcpConfig(...contents: Array<string | null | undefined>): {
  settings: Record<string, unknown>
  mcpServers: Record<string, unknown>
} {
  const settings: Record<string, unknown> = {}
  const mcpServers: Record<string, unknown> = {}

  for (const content of contents) {
    if (!content?.trim()) continue
    try {
      const parsed = JSON.parse(content)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      if (parsed.settings && typeof parsed.settings === 'object' && !Array.isArray(parsed.settings)) {
        for (const [key, value] of Object.entries(parsed.settings)) {
          if (key in PI_RUNTIME_MCP_SETTINGS) continue
          settings[key] = value
        }
      }
      if (parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)) {
        for (const [name, server] of Object.entries(parsed.mcpServers)) {
          if (HERMES_MCP_SERVER_NAMES.has(name)) continue
          if (LEGACY_HERMES_MCP_SERVER_NAMES.has(name)) continue
          if (isManagedHermesMcpServer(server)) continue
          if (server && typeof server === 'object' && !Array.isArray(server)) {
            const normalized = { ...(server as Record<string, unknown>) }
            if (normalized.enabled === false) continue
            delete normalized.enabled
            mcpServers[name] = normalized
          } else {
            mcpServers[name] = server
          }
        }
      }
    } catch {
      // Invalid user JSON remains editable and is ignored only for launch-time merging.
    }
  }

  return { settings, mcpServers }
}

function piUserMcpConfig(...existingContents: Array<string | null | undefined>): string {
  const external = parsePiExternalMcpConfig(...existingContents)
  return `${JSON.stringify({
    ...(Object.keys(external.settings).length > 0 ? { settings: external.settings } : {}),
    mcpServers: external.mcpServers,
  }, null, 2)}\n`
}

function piMcpConfig(profile: string, ...externalContents: Array<string | null | undefined>): string {
  const external = parsePiExternalMcpConfig(...externalContents)
  const disabledManaged = getDisabledManagedMcpServers('pi', profile)
  const mcpServers = Object.fromEntries(HERMES_MCP_SERVERS
    .filter(item => !disabledManaged.has(item.name))
    .map((item) => {
    const server = managedHermesMcpServerConfig('pi', profile, item.name, item.toolset)
    const requestTimeoutMs = item.toolset === 'api' ? 120_000 : item.toolset === 'use' ? 360_000 : 1_860_000
    return [item.name, {
      ...server,
      lifecycle: 'lazy',
      directTools: false,
      toolPrefix: 'none',
      requestTimeoutMs,
    }]
  }))
  return `${JSON.stringify({
    settings: {
      ...external.settings,
      ...PI_RUNTIME_MCP_SETTINGS,
    },
    mcpServers: {
      ...external.mcpServers,
      ...mcpServers,
    },
  }, null, 2)}\n`
}

function opencodeMcpServerConfig(server: Record<string, unknown>, enabled: boolean): Record<string, unknown> {
  const command = typeof server.command === 'string' ? server.command : ''
  const args = Array.isArray(server.args) ? server.args.map(String) : []
  if (command) {
    return {
      type: 'local',
      command: [command, ...args],
      enabled,
      ...(typeof server.timeout === 'number' ? { timeout: server.timeout } : {}),
      ...(server.env && typeof server.env === 'object' && !Array.isArray(server.env)
        ? { environment: server.env }
        : {}),
    }
  }
  return {
    type: 'remote',
    url: String(server.url || ''),
    enabled,
    ...(typeof server.timeout === 'number' ? { timeout: server.timeout } : {}),
    ...(server.headers && typeof server.headers === 'object' && !Array.isArray(server.headers)
      ? { headers: server.headers }
      : {}),
  }
}

function parseOpenCodeConfig(...contents: Array<string | null | undefined>): Record<string, any> {
  let config: Record<string, any> = {}
  for (const content of contents) {
    if (!content?.trim()) continue
    try {
      const parsed = JSON.parse(content)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      config = {
        ...config,
        ...parsed,
        provider: {
          ...(config.provider && typeof config.provider === 'object' ? config.provider : {}),
          ...(parsed.provider && typeof parsed.provider === 'object' ? parsed.provider : {}),
        },
        mcp: {
          ...(config.mcp && typeof config.mcp === 'object' ? config.mcp : {}),
          ...(parsed.mcp && typeof parsed.mcp === 'object' ? parsed.mcp : {}),
        },
      }
    } catch {
      // Invalid user JSON remains editable and is ignored only for launch-time merging.
    }
  }
  return config
}

function parseEditableOpenCodeConfig(content: string): Record<string, any> {
  try {
    const parsed = JSON.parse(content || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {}
  const err = new Error('OpenCode configuration contains invalid JSON')
  ;(err as any).status = 400
  throw err
}

function openCodeSettingsConfig(content: string): string {
  const config = parseEditableOpenCodeConfig(content)
  delete config.mcp
  return `${JSON.stringify(config, null, 2)}\n`
}

function mergeOpenCodeSettingsConfig(existingContent: string, settingsContent: string): string {
  const existing = parseEditableOpenCodeConfig(existingContent)
  const settings = parseEditableOpenCodeConfig(settingsContent)
  delete settings.mcp
  const merged: Record<string, any> = { ...settings }
  if (Object.prototype.hasOwnProperty.call(existing, 'mcp')) merged.mcp = existing.mcp
  else delete merged.mcp
  return `${JSON.stringify(merged, null, 2)}\n`
}

function opencodeRuntimeConfig(
  profile: string,
  runtime: {
    provider?: string
    model?: string
    baseUrl?: string
    systemPrompt?: string
  },
  ...existingContents: Array<string | null | undefined>
): string {
  const config = parseOpenCodeConfig(...existingContents)
  const externalMcp = config.mcp && typeof config.mcp === 'object' && !Array.isArray(config.mcp)
    ? { ...config.mcp }
    : {}
  for (const name of [...HERMES_MCP_SERVER_NAMES, ...LEGACY_HERMES_MCP_SERVER_NAMES]) delete externalMcp[name]
  const disabledManaged = getDisabledManagedMcpServers('opencode', profile)
  const managedMcp = Object.fromEntries(HERMES_MCP_SERVERS.map((item) => {
    const server = managedHermesMcpServerConfig('opencode', profile, item.name, item.toolset)
    return [item.name, opencodeMcpServerConfig(server, !disabledManaged.has(item.name))]
  }))
  const inheritedInstructions = Array.isArray(config.instructions)
    ? config.instructions.map(String)
    : typeof config.instructions === 'string'
      ? [config.instructions]
      : []
  if (runtime.model) {
    delete config.model
    delete config.provider
  }
  delete config.instructions
  return `${JSON.stringify({
    ...config,
    $schema: 'https://opencode.ai/config.json',
    ...(runtime.model ? {
      model: `${OPENCODE_PROVIDER_ID}/${runtime.model}`,
      provider: {
        [OPENCODE_PROVIDER_ID]: {
          npm: '@ai-sdk/openai',
          name: runtime.provider || 'Ekko Studio',
          options: {
            baseURL: runtime.baseUrl || '',
            apiKey: `{env:${OPENCODE_API_KEY_ENV}}`,
          },
          models: {
            [runtime.model]: {
              name: displayNameForModel(runtime.model),
              // Always forward images; let the upstream model handle support.
              attachment: true,
              modalities: { input: ['text', 'image'], output: ['text'] },
            },
          },
        },
      },
    } : {}),
    ...((inheritedInstructions.length || runtime.systemPrompt) ? {
      instructions: [...new Set([
        ...inheritedInstructions,
        ...(runtime.systemPrompt ? [runtime.systemPrompt] : []),
      ])],
    } : {}),
    mcp: {
      ...externalMcp,
      ...managedMcp,
    },
    permission: { '*': 'allow' },
  }, null, 2)}\n`
}

function openCodeRuntimeEnv(input: {
  configDir: string
  databasePath: string
  runtimeConfig?: string
  apiKey?: string
}): Record<string, string> {
  // OPENCODE_CONFIG_DIR is OpenCode's native global-config override. Keep it
  // stable at the provider/profile root so OpenCode installs its plugin SDK
  // once and discovers the same agents, commands, plugins, skills, memory, and
  // MCP configuration for terminal, chat, group-chat, and workflow launches.
  //
  // Per-conversation provider credentials and model selection are applied with
  // OPENCODE_CONFIG_CONTENT, which OpenCode intentionally loads last. The
  // native database remains isolated per conversation. Do not redirect HOME or
  // XDG because that would also redirect git, ssh, npm, and child shells.
  return {
    OPENCODE_CONFIG_DIR: input.configDir,
    OPENCODE_DB: input.databasePath,
    ...(input.runtimeConfig ? { [OPENCODE_RUNTIME_CONFIG_ENV]: input.runtimeConfig } : {}),
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    ...(input.apiKey ? { [OPENCODE_API_KEY_ENV]: input.apiKey } : {}),
  }
}

export function getCodingAgentManagedMcpServerConfigs(
  id: CodingAgentId,
  profile = 'default',
): Record<string, Record<string, unknown>> {
  if (!['claude-code', 'codex', 'pi', 'grok', 'opencode', 'dsh'].includes(id)) return {}
  const disabledManaged = getDisabledManagedMcpServers(id, profile)
  return Object.fromEntries(HERMES_MCP_SERVERS.map((item) => {
    const server = managedHermesMcpServerConfig(id, profile || 'default', item.name, item.toolset)
    if (id === 'pi') {
      const requestTimeoutMs = item.toolset === 'api' ? 120_000 : item.toolset === 'use' ? 360_000 : 1_860_000
      return [item.name, {
        ...server,
        lifecycle: 'lazy',
        directTools: false,
        toolPrefix: 'none',
        requestTimeoutMs,
        ...(disabledManaged.has(item.name) ? { enabled: false } : {}),
      }]
    }
    if (id === 'codex' || id === 'grok') {
      return [item.name, {
        ...server,
        startup_timeout_sec: 120,
        ...((item.toolset === 'use' || item.toolset === 'plan') ? { tool_timeout_sec: Math.max(360, Number(server.tool_timeout_sec) || 0) } : {}),
        ...(disabledManaged.has(item.name) ? { enabled: false } : {}),
      }]
    }
    if (id === 'opencode') {
      return [item.name, opencodeMcpServerConfig(server, !disabledManaged.has(item.name))]
    }
    return [item.name, {
      ...server,
      ...(disabledManaged.has(item.name) ? { enabled: false } : {}),
    }]
  }))
}

function migratePiRuntimeMcpContent(content: string): string | null {
  try {
    const parsed = JSON.parse(content)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const servers = parsed.mcpServers
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return null
    const managedServers = Object.entries(servers)
      .filter(([name, server]) => HERMES_MCP_SERVER_NAMES.has(name) || isManagedHermesMcpServer(server))
    if (managedServers.length === 0) return null

    const settings = parsed.settings && typeof parsed.settings === 'object' && !Array.isArray(parsed.settings)
      ? parsed.settings
      : {}
    parsed.settings = {
      ...settings,
      ...PI_RUNTIME_MCP_SETTINGS,
    }
    delete parsed.settings.freezeDirectTools

    for (const [, server] of managedServers) {
      if (!server || typeof server !== 'object' || Array.isArray(server)) continue
      const managedServer = server as Record<string, unknown>
      managedServer.lifecycle = 'lazy'
      managedServer.directTools = false
    }

    const migrated = `${JSON.stringify(parsed, null, 2)}\n`
    return migrated === content ? null : migrated
  } catch {
    return null
  }
}

/**
 * Upgrade persisted Pi runtime files created before MCP proxy mode became the
 * default. LazyCat app upgrades preserve /home, so old launchers may otherwise
 * keep registering every MCP tool directly until the user prepares a new run.
 */
export async function migratePersistedPiRuntimeMcpConfigs(): Promise<number> {
  const modelRoot = join(getWebUiHome(), CODING_AGENT_HOME_DIR, 'model')
  if (!existsSync(modelRoot)) return 0

  const candidates: string[] = []
  const directories = (path: string) => {
    try {
      return readdirSync(path, { withFileTypes: true }).filter(entry => entry.isDirectory())
    } catch {
      return []
    }
  }

  for (const profile of directories(modelRoot)) {
    const profileRoot = join(modelRoot, profile.name)
    for (const provider of directories(profileRoot)) {
      const piRoot = join(profileRoot, provider.name, 'pi')
      if (!existsSync(piRoot)) continue
      candidates.push(join(piRoot, 'mcp.json'))
      for (const run of directories(join(piRoot, 'runs'))) {
        candidates.push(join(piRoot, 'runs', run.name, 'mcp.json'))
      }
      for (const room of directories(join(piRoot, 'group-chat'))) {
        for (const agent of directories(join(piRoot, 'group-chat', room.name))) {
          candidates.push(join(piRoot, 'group-chat', room.name, agent.name, 'mcp.json'))
        }
      }
    }
  }

  let migratedCount = 0
  for (const path of candidates) {
    const content = await safeReadFile(path)
    if (!content) continue
    const migrated = migratePiRuntimeMcpContent(content)
    if (!migrated) continue
    await writeFile(path, migrated, 'utf-8')
    migratedCount += 1
  }
  return migratedCount
}

function persistedPiRuntimeRoots(): string[] {
  const modelRoot = join(getWebUiHome(), CODING_AGENT_HOME_DIR, 'model')
  if (!existsSync(modelRoot)) return []
  const roots: string[] = []
  const directories = (path: string) => {
    try {
      return readdirSync(path, { withFileTypes: true }).filter(entry => entry.isDirectory())
    } catch {
      return []
    }
  }

  for (const profile of directories(modelRoot)) {
    const profileRoot = join(modelRoot, profile.name)
    for (const provider of directories(profileRoot)) {
      const piRoot = join(profileRoot, provider.name, 'pi')
      if (!existsSync(piRoot)) continue
      roots.push(piRoot)
      for (const run of directories(join(piRoot, 'runs'))) {
        roots.push(join(piRoot, 'runs', run.name))
      }
      for (const room of directories(join(piRoot, 'group-chat'))) {
        for (const agent of directories(join(piRoot, 'group-chat', room.name))) {
          roots.push(join(piRoot, 'group-chat', room.name, agent.name))
        }
      }
    }
  }
  return roots
}

export async function restorePersistedPiProxyTargets(): Promise<number> {
  let restoredCount = 0
  for (const root of persistedPiRuntimeRoots()) {
    const targetPath = join(root, PI_PROXY_TARGET_FILE)
    let content = await safeReadFile(targetPath)
    if (!content) {
      const modelsContent = await safeReadFile(join(root, 'models.json'))
      if (!modelsContent) continue
      try {
        const models = JSON.parse(modelsContent)
        const providerConfig = models?.providers?.[PI_PROVIDER_ID]
        const proxyBaseUrl = String(providerConfig?.baseUrl || '').trim()
        const token = String(providerConfig?.apiKey || '').trim()
        const routeKey = proxyBaseUrl.match(/\/api\/codex-proxy\/([^/]+)\/v1\/?$/)?.[1] || ''
        if (!routeKey || !token) continue
        const keyParts = JSON.parse(Buffer.from(routeKey, 'base64url').toString('utf-8'))
        if (!Array.isArray(keyParts) || keyParts.length < 5) continue
        const [profile, provider, model, apiMode, baseUrl, agentSessionId = '', chatSessionId = ''] = keyParts.map(value => String(value || ''))
        const resolved = await resolveStoredProviderLaunchInput({
          profile,
          provider,
          model,
          apiMode: normalizeLaunchApiMode(apiMode, 'chat_completions'),
          baseUrl,
          sessionId: chatSessionId,
        }, null)
        const apiKey = String(resolved.apiKey || '').trim()
        if (!apiKey && provider !== OPENCODE_FREE_PROVIDER) continue
        content = await serializePiProxyTarget({
          profile,
          provider,
          model,
          apiMode,
          baseUrl,
          agentId: 'pi',
          agentSessionId,
          chatSessionId,
        }, apiKey, token)
        await atomicWritePrivateFile(targetPath, content)
      } catch {
        continue
      }
    }
    try {
      const persisted = JSON.parse(content)
      const input = persisted?.input
      const token = String(persisted?.token || '').trim()
      const legacyApiKey = String(input?.apiKey || '').trim()
      if (!input || typeof input !== 'object' || !token) continue
      const encryptedVersion = Number(persisted?.apiKeyEncrypted?.v || 0)
      const decrypted = legacyApiKey || await decryptPiProxyApiKey(persisted?.apiKeyEncrypted, input, token)
      if (decrypted === null) continue
      const apiKey = decrypted.trim()
      if (!String(input.profile || '').trim()
        || !String(input.provider || '').trim()
        || !String(input.model || '').trim()
        || !String(input.baseUrl || '').trim()
        || (!apiKey && input.provider !== OPENCODE_FREE_PROVIDER)) continue
      const restoredInput = { ...input, apiKey }
      delete restoredInput.apiKeyEncrypted
      restoreCodexProxyTarget(restoredInput, token)
      if (legacyApiKey || encryptedVersion === 1) {
        const migratedInput = { ...input }
        delete migratedInput.apiKey
        await atomicWritePrivateFile(
          targetPath,
          await serializePiProxyTarget(migratedInput, apiKey, token),
        )
      }
      await chmod(targetPath, 0o600)
      restoredCount += 1
    } catch {
      // Ignore invalid or legacy files; preparing the launch rewrites them.
    }
  }
  return restoredCount
}

function persistedCodexProxyConfigs(): Array<{ agentId: 'codex' | 'grok'; path: string }> {
  const modelRoot = join(getWebUiHome(), CODING_AGENT_HOME_DIR, 'model')
  if (!existsSync(modelRoot)) return []
  const configs: Array<{ agentId: 'codex' | 'grok'; path: string }> = []
  const visit = (path: string, agentId: 'codex' | 'grok') => {
    let entries
    try {
      entries = readdirSync(path, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      return
    }
    for (const entry of entries) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) visit(child, agentId)
      else if (entry.isFile() && entry.name === 'config.toml') configs.push({ agentId, path: child })
    }
  }
  const directories = (path: string) => {
    try {
      return readdirSync(path, { withFileTypes: true, encoding: 'utf8' }).filter(entry => entry.isDirectory())
    } catch {
      return []
    }
  }
  for (const profile of directories(modelRoot)) {
    for (const provider of directories(join(modelRoot, profile.name))) {
      for (const agentId of ['codex', 'grok'] as const) {
        const agentRoot = join(modelRoot, profile.name, provider.name, agentId)
        if (existsSync(agentRoot)) visit(agentRoot, agentId)
      }
    }
  }
  return configs
}

function tomlSectionString(content: string, sectionName: string, key: string): string {
  let section = ''
  for (const line of content.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/)
    if (header) {
      section = header[1].trim()
      continue
    }
    if (section !== sectionName) continue
    const assignment = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(\"(?:[^\"\\]|\\.)*\")\s*(?:#.*)?$/)
    if (assignment?.[1] !== key) continue
    try {
      return JSON.parse(assignment[2])
    } catch {
      return ''
    }
  }
  return ''
}

export async function restorePersistedCodexProxyTargets(): Promise<number> {
  let restoredCount = 0
  const restoredRouteKeys = new Set<string>()
  for (const config of persistedCodexProxyConfigs()) {
    const content = await safeReadFile(config.path)
    if (!content) continue
    const proxyBaseUrl = tomlSectionString(content, 'model_providers.custom', 'base_url')
    const token = tomlSectionString(content, 'model_providers.custom', 'experimental_bearer_token')
    const routeKey = proxyBaseUrl.match(/\/api\/codex-proxy\/([^/]+)\/v1\/?$/)?.[1] || ''
    if (!routeKey || !token || restoredRouteKeys.has(routeKey)) continue
    try {
      const keyParts = JSON.parse(Buffer.from(routeKey, 'base64url').toString('utf-8'))
      if (!Array.isArray(keyParts) || keyParts.length < 5) continue
      const [profile, provider, model, apiMode, baseUrl, agentSessionId = '', chatSessionId = ''] =
        keyParts.map(value => String(value || ''))
      const resolved = await resolveStoredProviderLaunchInput({
        mode: 'scoped',
        profile,
        provider,
        model,
        apiMode: normalizeLaunchApiMode(apiMode, 'chat_completions'),
        baseUrl,
        sessionId: chatSessionId,
      }, null)
      const apiKey = String(resolved.apiKey || '').trim()
      if (!profile || !provider || !model || !baseUrl || (!apiKey && provider !== OPENCODE_FREE_PROVIDER)) continue
      restoreCodexProxyTarget({
        profile,
        provider,
        model,
        baseUrl,
        apiKey,
        apiMode: normalizeLaunchApiMode(apiMode, 'chat_completions'),
        agentId: config.agentId,
        agentSessionId,
        chatSessionId,
      }, token)
      restoredRouteKeys.add(routeKey)
      restoredCount += 1
    } catch {
      // Ignore stale or invalid runtime configs; preparing the next launch rewrites them.
    }
  }
  return restoredCount
}

function piModelsConfig(input: {
  baseUrl: string
  apiKey: string
  apiMode: ApiMode
  model: string
  profile: string
  provider: string
  reasoningEffort?: string
}): string {
  const capabilities = getModelRuntimeCapabilities(input)
  const reasoning = piModelSupportsThinking(capabilities.reasoning, input.reasoningEffort)
  return `${JSON.stringify({
    providers: {
      [PI_PROVIDER_ID]: {
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        // The local Codex proxy exposes a Responses endpoint and performs the
        // selected upstream Chat Completions / Responses / Anthropic adaptation.
        api: 'openai-responses',
        models: [{
          id: input.model,
          name: displayNameForModel(input.model),
          reasoning,
          ...(reasoning ? { thinkingLevelMap: PI_EXTENDED_THINKING_LEVEL_MAP } : {}),
          input: capabilities.input,
          contextWindow: capabilities.contextWindow,
          maxTokens: capabilities.outputLimit,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      },
    },
  }, null, 2)}\n`
}

function piLiveConfigDefault(key: string, _profile: string): string | null {
  if (key === 'settings') return piSettingsConfig()
  if (key === 'mcp') return piUserMcpConfig()
  return null
}

async function ensurePiScopedBaseConfigFiles(scope: Required<CodingAgentConfigScope>): Promise<void> {
  const rootDir = getScopedConfigRoot('pi', scope)
  await mkdir(rootDir, { recursive: true })

  for (const definition of CONFIG_FILE_DEFINITIONS.pi) {
    const content = piLiveConfigDefault(definition.key, scope.profile)
    if (content == null) continue
    const absolutePath = join(rootDir, definition.scopedPath)
    if (existsSync(absolutePath)) continue
    await writeFile(absolutePath, content, { encoding: 'utf-8', flag: 'wx' }).catch((err: any) => {
      if (err?.code !== 'EEXIST') throw err
    })
  }
}

function shouldShareOpenCodeGlobalFile(name: string): boolean {
  if (name === 'AGENTS.md' || name === 'opencode.json' || name === 'opencode.jsonc') return false
  if (name === '.gitignore' || name === 'package.json' || name === 'package-lock.json' || name === 'bun.lock') return false
  if (name.endsWith('.lock') || name.endsWith('.pid') || name.endsWith('.sock')) return false
  if (name.endsWith('.db') || name.endsWith('.db-shm') || name.endsWith('.db-wal')) return false
  if (name.endsWith('.sqlite') || name.endsWith('.sqlite-shm') || name.endsWith('.sqlite-wal')) return false
  return !name.endsWith('.log')
}

async function shareOpenCodeGlobalEntry(source: string, target: string, type: 'file' | 'dir'): Promise<void> {
  if (await pathEntryExists(target)) return
  try {
    await symlink(source, target, process.platform === 'win32' && type === 'dir' ? 'junction' : type)
    return
  } catch (err: any) {
    if (err?.code !== 'EEXIST' && err?.code !== 'EPERM' && err?.code !== 'ENOTSUP' && err?.code !== 'EINVAL') {
      throw err
    }
    if (err?.code === 'EEXIST') return
  }
  if (type === 'dir') {
    await cp(source, target, {
      recursive: true,
      dereference: true,
      errorOnExist: false,
      force: false,
      preserveTimestamps: true,
    })
  } else {
    await copyFile(source, target)
  }
}

async function ensureOpenCodeScopedBaseConfigFiles(
  scope: Required<CodingAgentConfigScope>,
  systemPrompt: string,
  workspaceDir = resolveLaunchWorkspaceRoot(scope, null),
): Promise<{
  rootDir: string
  memoryFile: string
  promptFile: string
  configFile: string
  launcherFile: string
  launcherRuntimeConfig: string
}> {
  const rootDir = getScopedConfigRoot('opencode', scope)
  const sourceHome = dirname(getLiveConfigFileDefinition('opencode', 'config')?.absolutePath || '')
  await mkdir(rootDir, { recursive: true, mode: 0o700 })
  await mkdir(sourceHome, { recursive: true })

  for (const directory of OPENCODE_SHARED_CONFIG_DIRS) {
    const source = join(sourceHome, directory)
    const target = join(rootDir, directory)
    if (directory === 'skills') await mkdir(source, { recursive: true })
    if (!existsSync(source)) continue
    await shareOpenCodeGlobalEntry(source, target, 'dir')
  }

  if (sourceHome !== rootDir && existsSync(sourceHome)) {
    for (const entry of await readdir(sourceHome, { withFileTypes: true })) {
      if (!entry.isFile() || !shouldShareOpenCodeGlobalFile(entry.name)) continue
      await shareOpenCodeGlobalEntry(join(sourceHome, entry.name), join(rootDir, entry.name), 'file')
    }
  }

  const memoryFile = join(rootDir, 'AGENTS.md')
  const promptFile = join(rootDir, 'hermes-rules.md')
  const configFile = join(rootDir, OPENCODE_CONFIG_FILE)
  const globalInstructions = await safeReadFile(join(sourceHome, 'AGENTS.md')) || ''
  const globalConfig = await safeReadFile(join(sourceHome, OPENCODE_CONFIG_FILE))
    || await safeReadFile(join(sourceHome, 'opencode.jsonc'))
    || ''
  await writeFile(memoryFile, globalInstructions, 'utf-8')
  await writeManagedPromptFile(promptFile, systemPrompt, '')
  await writeFile(
    configFile,
    opencodeRuntimeConfig(scope.profile, {}, globalConfig),
    'utf-8',
  )
  const launcherRuntimeConfig = opencodeRuntimeConfig(scope.profile, { systemPrompt: promptFile })
  const env = openCodeRuntimeEnv({
    configDir: rootDir,
    databasePath: join(rootDir, OPENCODE_DATABASE_FILE),
    runtimeConfig: launcherRuntimeConfig,
  })
  const launcherFile = await writeLauncherScript({
    rootDir,
    workspaceDir,
    env,
    command: 'opencode',
    args: [],
  })
  return { rootDir, memoryFile, promptFile, configFile, launcherFile, launcherRuntimeConfig }
}

function buildLaunchShellCommand(input: {
  workspaceDir: string
  env: Record<string, string>
  command: string
  args: string[]
}): string {
  if (process.platform === 'win32') {
    const envAssignments = Object.entries(input.env)
      .map(([key, value]) => `$env:${key} = ${powerShellQuote(value)}`)
    return [
      `Set-Location -LiteralPath ${powerShellQuote(input.workspaceDir)}`,
      ...envAssignments,
      `& ${powerShellQuote(input.command)} ${input.args.map(powerShellQuote).join(' ')}`.trim(),
    ].join('; ')
  }

  const envPrefix = Object.entries(input.env).map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ')
  const runCommand = [
    envPrefix,
    shellQuote(input.command),
    ...input.args.map(shellQuote),
  ].filter(Boolean).join(' ')
  return `cd ${shellQuote(input.workspaceDir)} && ${runCommand}`
}

function buildPosixLauncherScript(input: {
  workspaceDir: string
  env: Record<string, string>
  command: string
  args: string[]
}): string {
  const exports = Object.entries(input.env)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
  const command = [
    shellQuote(input.command),
    ...input.args.map(shellQuote),
  ].join(' ')
  return [
    '#!/usr/bin/env bash',
    'set -e',
    `cd ${shellQuote(input.workspaceDir)}`,
    ...exports,
    `exec ${command}`,
    '',
  ].join('\n')
}

function buildPowerShellLauncherScript(input: {
  workspaceDir: string
  env: Record<string, string>
  command: string
  args: string[]
}): string {
  const envAssignments = Object.entries(input.env)
    .map(([key, value]) => `$env:${key} = ${powerShellQuote(value)}`)
  const command = [
    `& ${powerShellQuote(input.command)}`,
    ...input.args.map(powerShellQuote),
  ].join(' ')
  return [
    '$ErrorActionPreference = "Stop"',
    `Set-Location -LiteralPath ${powerShellQuote(input.workspaceDir)}`,
    ...envAssignments,
    command,
    'exit $LASTEXITCODE',
    '',
  ].join('\r\n')
}

async function writeLauncherScript(input: {
  rootDir: string
  workspaceDir: string
  env: Record<string, string>
  command: string
  args: string[]
}): Promise<string> {
  const isWindows = process.platform === 'win32'
  const launcherPath = join(input.rootDir, isWindows ? WINDOWS_LAUNCHER_FILE : POSIX_LAUNCHER_FILE)
  await writeFile(
    launcherPath,
    isWindows ? buildPowerShellLauncherScript(input) : buildPosixLauncherScript(input),
    'utf-8',
  )
  if (!isWindows) await chmod(launcherPath, 0o700)
  return launcherPath
}

function buildLauncherShellCommand(workspaceDir: string, launcherPath: string): string {
  return process.platform === 'win32'
    ? buildLaunchShellCommand({
        workspaceDir,
        env: {},
        command: 'powershell.exe',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcherPath],
      })
    : buildLaunchShellCommand({
        workspaceDir,
        env: {},
        command: launcherPath,
        args: [],
      })
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync(process.platform === 'win32' ? 'where' : 'which', [command], {
      encoding: 'utf-8',
      timeout: 3000,
      windowsHide: true,
    })
    return true
  } catch {
    return false
  }
}

function isDockerRuntime(): boolean {
  return existsSync('/.dockerenv') || process.env.container === 'docker'
}

async function openNativeTerminal(shellCommand: string): Promise<string> {
  if (process.platform === 'win32') {
    const escapedCommand = shellCommand.replace(/"/g, '""').replace(/\$/g, '`$')
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Start-Process -FilePath powershell.exe -ArgumentList @('-NoExit', '-Command', "${escapedCommand}")`,
    ], {
      encoding: 'utf-8',
      timeout: 8000,
      windowsHide: true,
    })
    return 'PowerShell'
  }

  if (process.platform === 'darwin') {
    await execFileAsync('osascript', [
      '-e',
      `tell application "Terminal" to do script ${appleScriptString(shellCommand)}`,
      '-e',
      'tell application "Terminal" to activate',
    ], {
      encoding: 'utf-8',
      timeout: 8000,
      windowsHide: true,
    })
    return 'Terminal.app'
  }

  if (process.platform === 'linux') {
    if (isDockerRuntime()) {
      const err = new Error('Native terminal is not available inside Docker')
      ;(err as any).status = 400
      throw err
    }
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      const err = new Error('Native terminal requires a Linux desktop session')
      ;(err as any).status = 400
      throw err
    }

    const candidates: Array<{ command: string; args: string[] }> = [
      { command: 'xdg-terminal-exec', args: ['bash', '-lc', shellCommand] },
      { command: 'gnome-terminal', args: ['--', 'bash', '-lc', shellCommand] },
      { command: 'konsole', args: ['-e', 'bash', '-lc', shellCommand] },
      { command: 'xfce4-terminal', args: ['--command', `bash -lc ${shellQuote(shellCommand)}`] },
      { command: 'kitty', args: ['bash', '-lc', shellCommand] },
      { command: 'alacritty', args: ['-e', 'bash', '-lc', shellCommand] },
      { command: 'xterm', args: ['-e', 'bash', '-lc', shellCommand] },
    ]

    const errors: string[] = []
    for (const candidate of candidates) {
      if (!(await commandExists(candidate.command))) continue
      try {
        await execFileAsync(candidate.command, candidate.args, {
          encoding: 'utf-8',
          timeout: 8000,
          windowsHide: true,
        })
        return candidate.command
      } catch (err: any) {
        errors.push(`${candidate.command}: ${normalizeError(err)}`)
      }
    }

    const err = new Error(errors[0] || 'No supported Linux terminal command was found')
    ;(err as any).status = 400
    throw err
  }

  const err = new Error('Native terminal launch is not supported on this platform')
  ;(err as any).status = 400
  throw err
}

function getLiveConfigFileDefinition(id: string, key: string): CodingAgentConfigFileDefinition | null {
  const tool = getCodingAgentDefinition(id)
  if (!tool) return null
  const definition = CONFIG_FILE_DEFINITIONS[tool.id].find(file => file.key === key)
  if (!definition) return null
  return {
    key: definition.key,
    path: definition.path,
    language: definition.language,
    absolutePath: expandHomePath(definition.path),
  }
}

function getScopedConfigFileDefinition(
  id: string,
  key: string,
  scopeInput: CodingAgentConfigScope = {},
  rootDirOverride?: string,
): (CodingAgentConfigFileDefinition & Required<CodingAgentConfigScope> & { rootDir: string }) | null {
  const tool = getCodingAgentDefinition(id)
  if (!tool) return null
  const definition = CONFIG_FILE_DEFINITIONS[tool.id].find(file => file.key === key)
  if (!definition) return null
  const scope = normalizeConfigScope(scopeInput)
  const rootDir = rootDirOverride || getScopedConfigRoot(tool.id, scope)
  return {
    key: definition.key,
    path: definition.path,
    language: definition.language,
    ...scope,
    rootDir,
    absolutePath: join(rootDir, definition.scopedPath),
  }
}

function getCurrentNodeEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: [getNodeBinDir(), getNvmNodeBinPaths(), process.env.PATH].filter(Boolean).join(delimiter),
    npm_node_execpath: process.execPath,
  }
}

async function npmExecution(args: string[], env: NodeJS.ProcessEnv): Promise<CommandExecution> {
  const bundledNpmCli = getNpmCliPath()
  if (bundledNpmCli) return { command: process.execPath, args: [bundledNpmCli, ...args] }

  let npmBin: string | null = null
  for (const command of [...new Set([getNpmBin(), 'npm'])]) {
    const paths = await findCommandPaths(command, env)
    if (paths[0]) {
      npmBin = paths[0]
      break
    }
  }
  if (!npmBin) throw nodeEnvironmentMissingError()

  const npmCli = npmCliFromNpmBin(npmBin)
  if (npmCli) return { command: npmCli.node, args: [npmCli.npmCli, ...args] }

  let nodeBin: string | null = null
  for (const command of [...new Set([process.platform === 'win32' ? 'node.exe' : 'node', 'node'])]) {
    const paths = await findCommandPaths(command, env)
    if (paths[0]) {
      nodeBin = paths[0]
      break
    }
  }
  if (!nodeBin) throw nodeEnvironmentMissingError()

  return commandExecution(npmBin, args)
}

async function runNpm(args: string[], options: { timeout?: number; env?: NodeJS.ProcessEnv } = {}) {
  const env = {
    ...getCurrentNodeEnv(),
    ...options.env,
  }
  const execution = await npmExecution(args, env)
  return execFileAsync(execution.command, execution.args, {
    encoding: 'utf-8',
    timeout: options.timeout,
    windowsHide: true,
    windowsVerbatimArguments: execution.windowsVerbatimArguments,
    maxBuffer: 10 * 1024 * 1024,
    env,
  })
}

function normalizeError(err: any): string {
  if (isNodeEnvironmentMissingError(err)) return nodeEnvironmentMissingError().message
  const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : ''
  const stdout = typeof err?.stdout === 'string' ? err.stdout.trim() : ''
  const message = stderr || stdout || err?.message || String(err)
  return message.split(/\r?\n/).filter(Boolean).slice(0, 4).join('\n')
}

function normalizeErrorCode(err: any): string | undefined {
  return isNodeEnvironmentMissingError(err) ? NODE_ENVIRONMENT_MISSING_CODE : undefined
}

async function findCommandPaths(command: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  try {
    const lookupCommand = process.platform === 'win32' ? 'where' : 'which'
    const lookupArgs = process.platform === 'win32' ? [command] : ['-a', command]
    const { stdout } = await execFileAsync(lookupCommand, lookupArgs, {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
      env,
    })
    return stdout.split(/\r?\n/).map(line => normalizeWindowsCommandPath(line.trim())).filter(Boolean)
  } catch {
    return []
  }
}

async function resolveCommandForExecution(command: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (process.platform !== 'win32') return command
  const paths = await findCommandPaths(command, env)
  // On Windows, prioritize paths with .cmd or .bat extensions since where may return
  // both the unix-style script (without extension) and the Windows shim (.cmd)
  const windowsPath = paths.find(path => windowsCommandNeedsShell(path))
  return windowsPath || paths[0] || command
}

function commandExecution(command: string, args: string[]): CommandExecution {
  const normalizedCommand = normalizeWindowsCommandPath(command)
  if (process.platform === 'win32' && windowsCommandNeedsShell(normalizedCommand)) {
    return windowsCmdShimExecution(normalizedCommand, args)
  }
  return { command: normalizedCommand, args }
}

const dshHost = createDshHost({ commandEnv, findCommandPaths, resolveCommandForExecution, commandExecution, getSourceHome: () => join(getGlobalConfigHome(), '.dsh') })
export const getNativeDshPluginInventory = dshHost.getNativeDshPluginInventory
export const dshPluginUi = dshHost.ui
export const dshAgentPresets = dshHost.presets
export const changeDshWebPlugins = dshHost.changePlugins

function packageParts(packageName: string): string[] {
  return packageName.split('/').filter(Boolean)
}

function getPrefixFromPackagePath(path: string, packageName: string): string | null {
  const normalized = path.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  const nodeModulesIndex = parts.lastIndexOf('node_modules')
  const packageNameParts = packageParts(packageName)

  if (nodeModulesIndex <= 0) return null
  for (let i = 0; i < packageNameParts.length; i += 1) {
    if (parts[nodeModulesIndex + 1 + i] !== packageNameParts[i]) return null
  }

  const libIndex = nodeModulesIndex - 1
  if (parts[libIndex] !== 'lib') return null
  const prefixParts = parts.slice(0, libIndex)
  if (prefixParts.length === 0) return process.platform === 'win32' ? null : '/'
  return `${normalized.startsWith('/') ? '/' : ''}${prefixParts.join('/')}`
}

async function getCommandPackagePrefixes(definition: CodingAgentDefinition, env: NodeJS.ProcessEnv): Promise<string[]> {
  const commandPaths = await findCommandPaths(definition.command, env)
  const prefixes = new Set<string>()

  for (const commandPath of commandPaths) {
    const candidates = [commandPath]
    try {
      candidates.push(realpathSync(commandPath))
    } catch {
      // Keep the unresolved command path as the fallback candidate.
    }

    for (const candidate of candidates) {
      const prefix = getPrefixFromPackagePath(candidate, definition.packageName)
      if (prefix) prefixes.add(prefix)
    }
  }
  return [...prefixes]
}

function extractVersion(raw: string): string {
  const trimmed = raw.trim()
  return trimmed.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0] || trimmed.split(/\s+/)[0] || ''
}

async function getGlobalNpmBin(): Promise<string | null> {
  if (typeof cachedGlobalNpmBin !== 'undefined') return cachedGlobalNpmBin
  try {
    const { stdout } = await runNpm(['prefix', '-g'], { timeout: 5000 })
    const prefix = stdout.trim()
    cachedGlobalNpmBin = prefix ? (process.platform === 'win32' ? prefix : join(prefix, 'bin')) : null
  } catch {
    cachedGlobalNpmBin = null
  }
  return cachedGlobalNpmBin
}

async function commandEnv(): Promise<NodeJS.ProcessEnv> {
  const env = getCurrentNodeEnv()
  const npmBin = await getGlobalNpmBin()
  const loginShellPath = await getLoginShellPath()
  prependPathEntries(env, [
    npmBin,
    loginShellPath,
    ...getDesktopCommonBinPaths(),
  ])
  return env
}

export function getCodingAgentDefinitions(): CodingAgentDefinition[] {
  return TOOL_DEFINITIONS.map(tool => ({ ...tool }))
}

export function getCodingAgentDefinition(id: string): CodingAgentDefinition | null {
  return TOOL_DEFINITIONS.find(tool => tool.id === id) || null
}

export function withCodingAgentRegistry(id: CodingAgentId, args: string[]): string[] {
  return id === 'codex' || id === 'grok' || id === 'opencode' || id === 'dsh'
    ? [...args, `--registry=${OFFICIAL_NPM_REGISTRY}`]
    : [...args]
}

export function piMcpAdapterInstallArgs(adapterRoot: string): string[] {
  return ['install', '--prefix', adapterRoot, PI_MCP_ADAPTER_PACKAGE]
}

export function getCodingAgentConfigFileDefinitions(id: string): CodingAgentConfigFileDefinition[] {
  const tool = getCodingAgentDefinition(id)
  if (!tool) return []
  return CONFIG_FILE_DEFINITIONS[tool.id].map(file => ({
    key: file.key,
    path: file.path,
    language: file.language,
    absolutePath: expandHomePath(file.path),
  }))
}

export async function getCodingAgentStatus(definition: CodingAgentDefinition): Promise<CodingAgentToolStatus> {
  let resolvedCommand = ''
  try {
    const env = await commandEnv()
    resolvedCommand = await resolveCommandForExecution(definition.command, env)
    const execution = commandExecution(resolvedCommand, ['--version'])
    const { stdout, stderr } = await execFileAsync(execution.command, execution.args, {
      encoding: 'utf-8',
      timeout: 8000,
      windowsHide: true,
      windowsVerbatimArguments: execution.windowsVerbatimArguments,
      env,
    })
    const rawVersion = `${stdout || ''}${stderr || ''}`.trim()
    if (definition.id === 'pi' && !existsSync(getPiMcpAdapterEntry())) {
      const userProvidesAdapter = userSettingsProvidesPiMcpAdapter(await readPiSettings())
      if (!userProvidesAdapter) {
        const status: CodingAgentToolStatus = {
          ...definition,
          installed: false,
          version: extractVersion(rawVersion),
          rawVersion,
          source: 'user-cli',
          path: resolvedCommand,
          error: 'Pi MCP Adapter is not installed',
        }
        recordCodingAgentStatus(status)
        return status
      }
    }
    const status: CodingAgentToolStatus = {
      ...definition,
      installed: true,
      version: extractVersion(rawVersion),
      rawVersion,
      source: 'user-cli',
      path: resolvedCommand,
    }
    recordCodingAgentStatus(status)
    return status
  } catch (err: any) {
    const commandLocated = resolvedCommand !== definition.command || existsSync(resolvedCommand)
    const status: CodingAgentToolStatus = {
      ...definition,
      installed: false,
      version: '',
      rawVersion: '',
      source: commandLocated ? 'user-cli' : 'not-installed',
      path: commandLocated ? resolvedCommand : '',
      error: normalizeError(err),
    }
    recordCodingAgentStatus(status)
    return status
  }
}

function recordCodingAgentStatus(status: CodingAgentToolStatus): void {
  updateAgentStatus(status.id, {
    name: status.name,
    provider: status.provider,
    kind: 'coding-agent',
    installed: status.installed,
    version: status.version,
    source: status.source,
    path: status.path,
    error: status.error || '',
    installations: [],
  })
}

export async function getCodingAgentsStatus(): Promise<CodingAgentsStatus> {
  return {
    tools: await Promise.all(TOOL_DEFINITIONS.map(tool => getCodingAgentStatus(tool))),
  }
}

export interface CodingAgentUpdateResult {
  success: boolean
  tool: CodingAgentToolStatus
  latestVersion: string
  updateAvailable: boolean
  message?: string
}

export function versionGte(a: string, b: string, includePrerelease = false): boolean {
  const x = String(a).match(/\d+(?:\.\d+){0,2}/)
  const y = String(b).match(/\d+(?:\.\d+){0,2}/)
  if (!x || !y) return String(a) === String(b)
  const p = x[0].split('.').map(Number)
  const q = y[0].split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    const u = p[i] || 0
    const v = q[i] || 0
    if (u !== v) return u > v
  }
  if (includePrerelease) {
    const prerelease = (version: string) => version.match(/\d+(?:\.\d+){0,2}-([0-9A-Za-z.-]+)/)?.[1].split('.')
    const left = prerelease(a)
    const right = prerelease(b)
    if (!left || !right) return !left
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
      if (left[i] === right[i]) continue
      if (left[i] === undefined || right[i] === undefined) return right[i] === undefined
      const ln = /^\d+$/.test(left[i])
      const rn = /^\d+$/.test(right[i])
      if (ln !== rn) return !ln
      return ln ? Number(left[i]) > Number(right[i]) : left[i] > right[i]
    }
  }
  return true
}

export function codexToolSearchConfig(version: string): { toolSearch: boolean; alwaysDefer: boolean } {
  if (!String(version || '').trim()) {
    // Keep the pre-gating behavior when the CLI version cannot be resolved.
    return { toolSearch: true, alwaysDefer: true }
  }
  const toolSearch = versionGte(version, CODEX_TOOL_SEARCH_MIN_VERSION)
  return {
    toolSearch,
    alwaysDefer: toolSearch && !versionGte(version, CODEX_TOOL_SEARCH_ALWAYS_DEFER_REMOVED_VERSION),
  }
}

async function resolveCodexToolSearchConfig(): Promise<{ toolSearch: boolean; alwaysDefer: boolean }> {
  if (process.env.VITEST) return { toolSearch: true, alwaysDefer: true }
  if (cachedCodexVersion && Date.now() - cachedCodexVersion.checkedAt < CODEX_VERSION_CACHE_TTL_MS) {
    return codexToolSearchConfig(cachedCodexVersion.version)
  }
  const definition = getCodingAgentDefinition('codex')
  if (!definition) return { toolSearch: true, alwaysDefer: true }
  const status = await getCodingAgentStatus(definition)
  cachedCodexVersion = { version: status.version, checkedAt: Date.now() }
  return codexToolSearchConfig(status.version)
}

export async function checkUpdateAgent(id: string): Promise<CodingAgentUpdateResult> {
  const tool = getCodingAgentDefinition(id)
  if (!tool) {
    const err = new Error('Unknown coding agent')
    ;(err as any).status = 400
    throw err
  }
  try {
    const env = await commandEnv()
    const { stdout } = await runNpm(
      withCodingAgentRegistry(tool.id, ['view', tool.packageName, 'version']),
      { timeout: 15_000, env },
    )
    const latestVersion = stdout.trim()
    const status = await getCodingAgentStatus(tool)
    const updateAvailable = !!latestVersion && status.installed && !versionGte(status.version, latestVersion, id === 'dsh')
    return { success: true, tool: status, latestVersion, updateAvailable }
  } catch (err: any) {
    const status = await getCodingAgentStatus(tool)
    return { success: false, tool: status, latestVersion: '', updateAvailable: false, message: normalizeError(err) }
  }
}

export async function installCodingAgent(id: string): Promise<CodingAgentMutationResult> {
  const tool = getCodingAgentDefinition(id)
  if (!tool) {
    const err = new Error('Unknown coding agent')
    ;(err as any).status = 400
    throw err
  }
  if (installingTools.has(tool.id)) {
    const err = new Error('Install is already running')
    ;(err as any).status = 409
    throw err
  }

  installingTools.add(tool.id)
  try {
    const env = await commandEnv()
    await runNpm(withCodingAgentRegistry(
      tool.id,
      ['install', '-g', tool.packageName],
    ), {
      timeout: 10 * 60 * 1000,
      env,
    })
    if (tool.id === 'pi' && !userSettingsProvidesPiMcpAdapter(await readPiSettings())) {
      await installBundledPiMcpAdapter()
    }
    cachedGlobalNpmBin = undefined
    const status = await getCodingAgentStatus(tool)
    const allStatus = await getCodingAgentsStatus()
    return {
      success: status.installed,
      tool: status,
      tools: allStatus.tools,
      message: status.installed ? 'Installed' : status.error || 'Install completed but the command was not found',
    }
  } catch (err: any) {
    const status = await getCodingAgentStatus(tool)
    const allStatus = await getCodingAgentsStatus()
    return {
      success: false,
      tool: status,
      tools: allStatus.tools,
      message: normalizeError(err),
      code: normalizeErrorCode(err),
    }
  } finally {
    installingTools.delete(tool.id)
  }
}

export async function deleteCodingAgent(id: string): Promise<CodingAgentMutationResult> {
  const tool = getCodingAgentDefinition(id)
  if (!tool) {
    const err = new Error('Unknown coding agent')
    ;(err as any).status = 400
    throw err
  }
  if (deletingTools.has(tool.id)) {
    const err = new Error('Delete is already running')
    ;(err as any).status = 409
    throw err
  }

  deletingTools.add(tool.id)
  try {
    const env = await commandEnv()
    const packagePrefixes = await getCommandPackagePrefixes(tool, env)
    const uninstallArgsList = packagePrefixes.length > 0
      ? packagePrefixes.map(prefix => ['uninstall', '-g', '--prefix', prefix, tool.packageName])
      : [['uninstall', '-g', tool.packageName]]
    for (const uninstallArgs of uninstallArgsList) {
      await runNpm(uninstallArgs, {
        timeout: 10 * 60 * 1000,
        env,
      })
    }
    if (tool.id === 'pi') {
      await runNpm(['uninstall', '--prefix', getPiMcpAdapterRoot(), 'pi-mcp-adapter'], {
        timeout: 10 * 60 * 1000,
        env,
      })
    }
    codingAgentRunManager.stopMatching(launch => launch.agentId === tool.id, { reportClosed: true })
    cachedGlobalNpmBin = undefined
    const status = await getCodingAgentStatus(tool)
    const allStatus = await getCodingAgentsStatus()
    return {
      success: !status.installed,
      tool: status,
      tools: allStatus.tools,
      message: !status.installed ? 'Deleted' : 'Delete completed but the command is still available',
    }
  } catch (err: any) {
    const status = await getCodingAgentStatus(tool)
    const allStatus = await getCodingAgentsStatus()
    return {
      success: false,
      tool: status,
      tools: allStatus.tools,
      message: normalizeError(err),
      code: normalizeErrorCode(err),
    }
  } finally {
    deletingTools.delete(tool.id)
  }
}

export async function readCodingAgentConfigFile(id: string, key: string, scope: CodingAgentConfigScope = {}): Promise<CodingAgentConfigFileContent> {
  const normalizedScope = normalizeConfigScope(scope)
  const liveDefinition = getLiveConfigFileDefinition(id, key)
  const definition = id === 'grok' && key === 'mcp' && normalizedScope.provider !== 'default'
    ? getScopedConfigFileDefinition(id, key, normalizedScope)
    : liveDefinition
  if (!definition) {
    const err = new Error('Unknown coding agent config file')
    ;(err as any).status = 404
    throw err
  }

  try {
    const info = await stat(definition.absolutePath)
    if (!info.isFile()) {
      const err = new Error('Config path is not a file')
      ;(err as any).status = 400
      throw err
    }
    if (info.size > MAX_CONFIG_FILE_SIZE) {
      const err = new Error('Config file is too large to edit')
      ;(err as any).status = 413
      throw err
    }
    const sourceContent = await readFile(definition.absolutePath, 'utf-8')
    const globalGrokConfig = id === 'grok' && key === 'mcp' && liveDefinition
      && definition.absolutePath !== liveDefinition.absolutePath
      ? await safeReadFile(liveDefinition.absolutePath) || ''
      : ''
    const content = id === 'grok' && key === 'mcp'
      ? mergeGrokConfigWithManagedMcp(
        grokUserMcpConfig(`${globalGrokConfig}\n${sourceContent}`),
        codexMcpConfigToml(normalizedScope.profile, 'grok'),
      )
      : id === 'grok' && key === 'settings'
        ? grokSettingsConfig(sourceContent)
        : id === 'opencode' && key === 'settings'
          ? openCodeSettingsConfig(sourceContent)
        : sourceContent
    return {
      ...definition,
      ...normalizedScope,
      rootDir: dirname(definition.absolutePath),
      content,
      exists: true,
      size: info.size,
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err
    const defaultContent = id === 'grok' && key === 'mcp'
      ? mergeGrokConfigWithManagedMcp('', codexMcpConfigToml(normalizedScope.profile, 'grok'))
      : id === 'pi'
        ? piLiveConfigDefault(key, normalizedScope.profile) || ''
        : id === 'opencode' && key === 'settings'
          ? '{}\n'
          : id === 'dsh' && key === 'settings' ? '{}\n'
            : id === 'dsh' && key === 'mcp' ? '[]\n'
        : ''
    return {
      ...definition,
      ...normalizedScope,
      rootDir: dirname(definition.absolutePath),
      content: defaultContent,
      exists: false,
      size: Buffer.byteLength(defaultContent),
    }
  }
}

export async function writeCodingAgentConfigFile(id: string, key: string, content: string, scope: CodingAgentConfigScope = {}): Promise<CodingAgentConfigFileContent> {
  const normalizedScope = normalizeConfigScope(scope)
  const providerScoped = id === 'grok' && key === 'mcp' && normalizedScope.provider !== 'default'
  const definition = providerScoped
    ? getScopedConfigFileDefinition(id, key, normalizedScope)
    : getLiveConfigFileDefinition(id, key)
  if (!definition) {
    const err = new Error('Unknown coding agent config file')
    ;(err as any).status = 404
    throw err
  }
  if (id === 'dsh' && key === 'settings') validateDshSettings(content)
  if (id === 'dsh' && key === 'mcp') readDshMcpServers(content)
  let persistedContent = content || ''
  if (id === 'grok' && (key === 'mcp' || key === 'settings')) {
    const existingContent = await safeReadFile(definition.absolutePath) || ''
    persistedContent = key === 'mcp'
      ? mergeGrokUserMcpConfig(existingContent, persistedContent)
      : mergeGrokSettingsConfig(existingContent, persistedContent)
  } else if (id === 'opencode' && key === 'settings') {
    const existingContent = await safeReadFile(definition.absolutePath) || '{}'
    persistedContent = mergeOpenCodeSettingsConfig(existingContent, persistedContent)
  }
  const buffer = Buffer.from(persistedContent, 'utf-8')
  if (buffer.length > MAX_CONFIG_FILE_SIZE) {
    const err = new Error('Config file content is too large')
    ;(err as any).status = 413
    throw err
  }

  await mkdir(dirname(definition.absolutePath), { recursive: true })
  await writeFile(definition.absolutePath, buffer)
  invalidateCodingAgentConfigRuntime(id, normalizedScope, {
    profileScoped: providerScoped,
    providerScoped,
  })
  return {
    ...definition,
    ...normalizedScope,
    rootDir: dirname(definition.absolutePath),
    content: id === 'grok' && key === 'mcp'
      ? mergeGrokConfigWithManagedMcp(
          grokUserMcpConfig(persistedContent),
          codexMcpConfigToml(normalizedScope.profile, 'grok'),
        )
      : id === 'grok' && key === 'settings'
        ? grokSettingsConfig(persistedContent)
        : id === 'opencode' && key === 'settings'
          ? openCodeSettingsConfig(persistedContent)
        : content,
    exists: true,
    size: buffer.length,
  }
}

export function invalidateCodingAgentConfigRuntime(
  id: string,
  scope: CodingAgentConfigScope = {},
  options: { profileScoped?: boolean; providerScoped?: boolean } = {},
): { invalidatedRuns: number; deferredRuns: number } {
  const normalizedScope = normalizeConfigScope(scope)
  const result = codingAgentRunManager.invalidateMatching(launch => (
    launch.agentId === id
    && (!options.profileScoped || launch.profile === normalizedScope.profile)
    && (
      !options.providerScoped
      || normalizeScopeSegment(launch.provider, 'default', 'provider') === normalizedScope.provider
    )
  ))
  return { invalidatedRuns: result.invalidated, deferredRuns: result.deferred }
}

export async function prepareCodingAgentLaunch(id: string, input: CodingAgentLaunchInput): Promise<CodingAgentLaunchResult> {
  const tool = getCodingAgentDefinition(id)
  if (!tool) {
    const err = new Error('Unknown coding agent')
    ;(err as any).status = 400
    throw err
  }

  const mcpCapabilities = studioMcpCapabilities(getCodingAgentManagedMcpServerConfigs(tool.id, input.profile || 'default'))
  const mode = input.mode === 'global' ? 'global' : 'scoped'
  if (mode === 'global') {
    const scope = normalizeConfigScope({ profile: input.profile, provider: 'global' })
    const workspaceDir = resolveLaunchWorkspaceRoot(scope, input.workspace)
    await mkdir(workspaceDir, { recursive: true })
    if (tool.id === 'pi' && input.piOutputMode === 'rpc') {
      const rootDir = getScopedRuntimeConfigRoot(tool.id, scope, input)
      const dynamicPromptPath = join(rootDir, PI_DYNAMIC_PROMPT_FILE)
      const studioExtensionPath = join(rootDir, PI_STUDIO_EXTENSION_FILE)
      await mkdir(rootDir, { recursive: true })
      await writeFile(studioExtensionPath, piStudioRuntimeExtension(), 'utf-8')
      await writeFile(dynamicPromptPath, '', 'utf-8')
      const mcp = await prepareGlobalPiMcp(rootDir, scope.profile)
      const files = [
        { key: 'studio_extension', path: PI_STUDIO_EXTENSION_FILE, absolutePath: studioExtensionPath },
        { key: 'dynamic_prompt', path: PI_DYNAMIC_PROMPT_FILE, absolutePath: dynamicPromptPath },
        mcp.file,
      ]
      const env = {
        PI_CODING_AGENT_DIR: join(getGlobalConfigHome(), '.pi', 'agent'),
        HERMES_PI_DYNAMIC_PROMPT_FILE: dynamicPromptPath,
        ...(input.sessionId ? { [HERMES_STUDIO_SESSION_ENV_KEY]: input.sessionId } : {}),
      }
      const args = [
        '--mode', 'rpc',
        ...(input.agentNativeSessionId ? ['--session-id', input.agentNativeSessionId] : []),
        '--extension', studioExtensionPath,
        ...mcp.args,
        input.approveProjectConfig === true ? '--approve' : '--no-approve',
      ]
      const launcherPath = await writeLauncherScript({
        rootDir,
        workspaceDir,
        env,
        command: tool.command,
        args,
      })
      files.push({
        key: 'launcher',
        path: process.platform === 'win32' ? WINDOWS_LAUNCHER_FILE : POSIX_LAUNCHER_FILE,
        absolutePath: launcherPath,
      })
      return {
        agentId: tool.id,
        mode,
        profile: scope.profile,
        provider: scope.provider,
        model: '',
        rootDir,
        workspaceDir,
        command: tool.command,
        args,
        env,
        shellCommand: buildLauncherShellCommand(workspaceDir, launcherPath),
        files,
        reasoningEffort: String(input.reasoningEffort || '').trim(),
      }
    }
    const rootDir = getScopedRuntimeConfigRoot(tool.id, scope, input)
    const systemPrompt = input.groupSystemPrompt?.trim()
      ? [input.groupSystemPrompt.trim(), studioMcpUsageGuidelines(mcpCapabilities)].filter(Boolean).join('\n\n')
      : getSystemPrompt(undefined, { mcpCapabilities })
    await mkdir(rootDir, { recursive: true })

    let promptFile = ''
    let files: Array<{ key: string; path: string; absolutePath: string }> = []
    let args: string[] = []
    let env: Record<string, string> = {}

    if (tool.id === 'claude-code') {
      promptFile = join(rootDir, 'hermes-rules.md')
      await writeManagedPromptFile(promptFile, systemPrompt, '')
      const mcpPath = join(rootDir, 'mcp.json')
      await writeFile(mcpPath, claudeMcpConfigJson(scope.profile,
        await safeReadFile(getLiveConfigFileDefinition('claude-code', 'mcp')?.absolutePath || ''),
      ), { mode: 0o600 })
      files = [
        { key: 'prompt', path: 'hermes-rules.md', absolutePath: promptFile },
        { key: 'mcp', path: 'mcp.json', absolutePath: mcpPath },
      ]
      args = ['--append-system-prompt-file', promptFile, '--mcp-config', mcpPath, ...claudeCodePermissionArgs()]
    } else if (tool.id === 'codex') {
      promptFile = await prepareGlobalCodexShadowHome(rootDir, systemPrompt, scope.profile)
      files = [
        { key: 'agents', path: 'AGENTS.md', absolutePath: promptFile },
        { key: 'config', path: 'config.toml', absolutePath: join(rootDir, 'config.toml') },
      ]
      env = { CODEX_HOME: rootDir }
    } else if (tool.id === 'grok') {
      const prepared = await prepareGlobalGrokRuntime({
        sourceHome: process.env.GROK_HOME?.trim() || join(getGlobalConfigHome(), '.grok'),
        rootDir,
        systemPrompt,
        managedMcpToml: codexMcpConfigToml(scope.profile, 'grok'),
      })
      promptFile = prepared.promptFile
      files = prepared.files
      env = { GROK_HOME: rootDir }
      args = ['--always-approve', '--no-auto-update']
    } else if (tool.id === 'dsh') {
      const prepared = await prepareDshRuntime({
        ...await dshHost.runtimeInput(),
        sharedSkills: join(getGlobalConfigHome(), '.agents', 'skills'),
        rootDir, systemPrompt, managedMcp: getCodingAgentManagedMcpServerConfigs('dsh', scope.profile),
      })
      promptFile = prepared.promptFile
      files = prepared.files
      args = prepared.args
      env = prepared.env
    } else if (tool.id === 'opencode') {
      const prepared = await ensureOpenCodeScopedBaseConfigFiles(scope, systemPrompt, workspaceDir)
      // Share native configuration, but keep each conversation's dynamic
      // instructions separate from other chats and workflow/group-chat runs.
      promptFile = join(rootDir, 'hermes-rules.md')
      await writeManagedPromptFile(promptFile, systemPrompt, '')
      env = openCodeRuntimeEnv({
        configDir: prepared.rootDir,
        // Preserve the existing database location so native sessions can resume.
        databasePath: join(prepared.rootDir, OPENCODE_DATABASE_FILE),
        runtimeConfig: opencodeRuntimeConfig(scope.profile, { systemPrompt: promptFile }),
      })
      const launcherFile = await writeLauncherScript({
        rootDir,
        workspaceDir,
        env,
        command: tool.command,
        args,
      })
      files = [
        { key: 'agents', path: 'AGENTS.md', absolutePath: prepared.memoryFile },
        { key: 'prompt', path: 'hermes-rules.md', absolutePath: promptFile },
        { key: 'config', path: OPENCODE_CONFIG_FILE, absolutePath: prepared.configFile },
        {
          key: 'launcher',
          path: process.platform === 'win32' ? WINDOWS_LAUNCHER_FILE : POSIX_LAUNCHER_FILE,
          absolutePath: launcherFile,
        },
      ]
    } else {
      promptFile = join(rootDir, 'APPEND_SYSTEM.md')
      await writeManagedPromptFile(promptFile, systemPrompt, '')
      files = [{ key: 'prompt', path: 'APPEND_SYSTEM.md', absolutePath: promptFile }]
      args = ['--append-system-prompt', promptFile]
      if (tool.id === 'pi') {
        const mcp = await prepareGlobalPiMcp(rootDir, scope.profile)
        files.push(mcp.file)
        args.push(...mcp.args)
        env = { PI_CODING_AGENT_DIR: join(getGlobalConfigHome(), '.pi', 'agent') }
      }
    }
    const chatSessionId = String(input.sessionId || '').trim()
    if (chatSessionId) env[HERMES_STUDIO_SESSION_ENV_KEY] = chatSessionId
    const shellCommand = buildLaunchShellCommand({
      workspaceDir,
      env,
      command: tool.command,
      args,
    })
    return {
      agentId: tool.id,
      mode,
      profile: scope.profile,
      provider: scope.provider,
      model: '',
      rootDir,
      workspaceDir,
      command: tool.command,
      args,
      env,
      shellCommand,
      files,
      promptFile,
    }
  }

  const provider = normalizeProviderIdentity(input.provider)
  const scope = normalizeConfigScope({ profile: input.profile, provider })
  const model = String(input.model || '').trim()
  const freeRuntime = provider === OPENCODE_FREE_PROVIDER ? openCodeFreeRuntime(model) : undefined
  const apiKey = freeRuntime ? '' : String(input.apiKey || '').trim()
  assertScopedCodingAgentProviderAllowed(mode, provider)
  if (!model) {
    const err = new Error('Model is required')
    ;(err as any).status = 400
    throw err
  }

  const baseUrl = freeRuntime?.baseUrl || String(input.baseUrl || '').trim()
  const preset = PROVIDER_PRESETS.find(item => item.value === provider)
  const apiMode = freeRuntime?.apiMode || normalizeLaunchApiMode(input.apiMode, preset?.api_mode || 'chat_completions')
  const reasoningEffort = String(input.reasoningEffort || '').trim()
  const groupSystemPrompt = String(input.groupSystemPrompt || '').trim()
  const scopedSystemPrompt = tool.id === 'pi' && groupSystemPrompt
    ? getSystemPrompt(undefined, { mcpCapabilities })
    : groupSystemPrompt
      ? [groupSystemPrompt, studioMcpUsageGuidelines(mcpCapabilities)].filter(Boolean).join('\n\n')
      : getSystemPrompt(undefined, { mcpCapabilities })
  const isolatedInput = tool.id === 'pi' || tool.id === 'dsh'
    ? {
        ...input,
        sessionId: input.sessionId || randomUUID(),
        agentSessionId: input.agentSessionId || randomUUID(),
      }
    : input
  const rootDir = getScopedRuntimeConfigRoot(tool.id, scope, isolatedInput)
  const workspaceDir = resolveLaunchWorkspaceRoot(scope, input.workspace)
  await mkdir(rootDir, { recursive: true })
  await mkdir(workspaceDir, { recursive: true })

  const files: Array<{ key: string; path: string; absolutePath: string }> = []
  const writeScopedFile = async (key: string, content: string) => {
    const definition = getScopedConfigFileDefinition(tool.id, key, scope, rootDir)
    if (!definition) return
    await mkdir(dirname(definition.absolutePath), { recursive: true })
    await writeFile(definition.absolutePath, content, 'utf-8')
    files.push({ key, path: definition.path, absolutePath: definition.absolutePath })
  }
  const writeRuntimeFile = async (key: string, path: string, content: string) => {
    const absolutePath = join(rootDir, path)
    await mkdir(dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, content, 'utf-8')
    files.push({ key, path, absolutePath })
  }

  let args: string[] = []
  let env: Record<string, string> = {}

  if (tool.id === 'claude-code') {
    const contextWindow = getModelContextLength({ profile: scope.profile, provider, model })
    const proxyTarget = baseUrl && (apiKey || freeRuntime)
      ? registerClaudeCodeProxyTarget({
          provider,
          model,
          baseUrl,
          apiKey,
          apiMode,
          reasoningEffort,
          agentId: tool.id,
          agentSessionId: isolatedInput.agentSessionId,
          chatSessionId: isolatedInput.sessionId,
        })
      : null
    const claudeBaseUrl = proxyTarget?.baseUrl || baseUrl
    const claudeApiKey = proxyTarget?.token || apiKey
    const modelName = displayNameForModel(model)
    const globalSettingsPath = getLiveConfigFileDefinition(tool.id, 'settings')?.absolutePath
    const inheritedSettings = inheritClaudeSettings(globalSettingsPath ? await safeReadFile(globalSettingsPath) : '')
    const inheritedEnv = inheritedSettings.env && typeof inheritedSettings.env === 'object' && !Array.isArray(inheritedSettings.env)
      ? inheritedSettings.env as Record<string, unknown>
      : {}
    const settings = {
      ...inheritedSettings,
      model,
      env: {
        ...inheritedEnv,
        ...(claudeApiKey ? { ANTHROPIC_API_KEY: claudeApiKey } : {}),
        ...(claudeBaseUrl ? { ANTHROPIC_BASE_URL: claudeBaseUrl } : {}),
        ANTHROPIC_MODEL: model,
        ANTHROPIC_CUSTOM_MODEL_OPTION: model,
        ANTHROPIC_CUSTOM_MODEL_OPTION_NAME: modelName,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: modelName,
        ANTHROPIC_DEFAULT_SONNET_MODEL: model,
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: modelName,
        ANTHROPIC_DEFAULT_OPUS_MODEL: model,
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: modelName,
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(contextWindow),
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(CLAUDE_CODE_AUTO_COMPACT_PERCENT),
        ENABLE_TOOL_SEARCH: 'true',
      },
    }
    env = settings.env
    await writeScopedFile('settings', `${JSON.stringify(settings, null, 2)}\n`)
    const globalMcpPath = getLiveConfigFileDefinition(tool.id, 'mcp')?.absolutePath
    const existingMcpPath = getScopedConfigFileDefinition(tool.id, 'mcp', scope)?.absolutePath
    const globalMcpConfig = globalMcpPath ? await safeReadFile(globalMcpPath) : ''
    const existingMcpConfig = existingMcpPath ? await safeReadFile(existingMcpPath) : ''
    await writeScopedFile('mcp', claudeMcpConfigJson(scope.profile, globalMcpConfig, existingMcpConfig))
    await writeScopedFile('prompt', hermesPromptDocument(scopedSystemPrompt))

    const settingsPath = join(rootDir, 'settings.json')
    const mcpPath = join(rootDir, 'mcp.json')
    const promptPath = join(rootDir, 'hermes-rules.md')
    args = [
      '--settings',
      settingsPath,
      ...(input.isolateSettings ? ['--setting-sources', 'local'] : []),
      '--mcp-config',
      mcpPath,
      '--append-system-prompt-file',
      promptPath,
      ...claudeCodePermissionArgs(),
    ]
  } else if (tool.id === 'codex') {
    if (apiMode !== 'chat_completions' && apiMode !== 'codex_responses' && apiMode !== 'anthropic_messages') {
      const err = new Error('Codex launch only supports OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages providers')
      ;(err as any).status = 400
      throw err
    }
    const proxyTarget = baseUrl && (apiKey || freeRuntime)
      ? registerCodexProxyTarget({
          profile: scope.profile,
          provider,
          model,
          baseUrl,
          apiKey,
          apiMode,
          reasoningEffort,
          agentId: tool.id,
          agentSessionId: isolatedInput.agentSessionId,
          chatSessionId: isolatedInput.sessionId,
        })
      : null
    const codexBaseUrl = proxyTarget?.baseUrl || baseUrl
    const codexApiKey = proxyTarget?.token || apiKey
    const providerId = 'custom'
    const catalogPath = join(rootDir, CODEX_MODEL_CATALOG_FILE)
    const toolSearchFeatures = await resolveCodexToolSearchConfig()
    const globalCodexConfig = await safeReadFile(getLiveConfigFileDefinition(tool.id, 'config')?.absolutePath || '')
    const scopedCodexConfig = await safeReadFile(getScopedConfigFileDefinition(tool.id, 'config', scope)?.absolutePath || '')
    const userRuntimeConfig = codexRuntimeUserConfig(globalCodexConfig, scopedCodexConfig)
    const featureConfig = userRuntimeConfig.featureLines.length || toolSearchFeatures.toolSearch || toolSearchFeatures.alwaysDefer
      ? [
          '',
          '[features]',
          ...userRuntimeConfig.featureLines,
          ...(toolSearchFeatures.toolSearch ? ['tool_search = true'] : []),
          ...(toolSearchFeatures.alwaysDefer ? ['tool_search_always_defer_mcp_tools = true'] : []),
        ]
      : []
    const codexUserInstructions = [
      (await activeGlobalCodexInstructions(getGlobalCodexHome())).trim(),
      (await safeReadFile(getScopedConfigFileDefinition(tool.id, 'agents', scope)?.absolutePath || ''))?.trim() || '',
    ].filter((value, index, values) => value && values.indexOf(value) === index)
    const effectiveCodexInstructions = [scopedSystemPrompt.trim(), ...codexUserInstructions]
      .filter(Boolean)
      .join('\n\n')
    const configToml = [
      ...userRuntimeConfig.topLevelLines,
      `model_catalog_json = ${JSON.stringify(catalogPath)}`,
      `model_provider = ${JSON.stringify(providerId)}`,
      `model = ${JSON.stringify(model)}`,
      'model_reasoning_summary = "auto"',
      ...(reasoningEffort ? [`model_reasoning_effort = ${JSON.stringify(reasoningEffort)}`] : []),
      `developer_instructions = ${tomlMultilineString(effectiveCodexInstructions)}`,
      'disable_response_storage = true',
      '',
      `[model_providers.${providerId}]`,
      `name = ${JSON.stringify(provider)}`,
      ...(codexBaseUrl ? [`base_url = ${JSON.stringify(codexBaseUrl)}`] : []),
      'wire_api = "responses"',
      'requires_openai_auth = false',
      ...(codexApiKey ? [`experimental_bearer_token = ${JSON.stringify(codexApiKey)}`] : []),
      '',
      ...userRuntimeConfig.sectionBlocks.flatMap(block => [block, '']),
      codexMcpConfigToml(
        scope.profile,
        'codex',
        globalCodexConfig,
        scopedCodexConfig,
      ),
      ...featureConfig,
    ].join('\n')
    const catalog = buildCodexModelCatalog({
      profile: scope.profile,
      provider,
      model,
      presetModels: Array.isArray(preset?.models) ? preset.models : [],
    })
    await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf-8')
    files.push({ key: 'model_catalog', path: CODEX_MODEL_CATALOG_FILE, absolutePath: catalogPath })
    await writeScopedFile('config', configToml)
    await writeManagedPromptFile(join(rootDir, 'AGENTS.md'), scopedSystemPrompt, codexUserInstructions.join('\n\n'))
    files.push({ key: 'agents', path: 'AGENTS.md', absolutePath: join(rootDir, 'AGENTS.md') })
    await writeScopedFile('auth', `${JSON.stringify({}, null, 2)}\n`)

    env = { CODEX_HOME: rootDir }
    args = [
      '--model', model,
      ...(reasoningEffort ? ['-c', `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`] : []),
    ]
  } else if (tool.id === 'pi') {
    const settings = await readPiSettings(scope)
    const skipBundledAdapter = userSettingsProvidesPiMcpAdapter(settings)
    if (!skipBundledAdapter && !existsSync(getPiMcpAdapterEntry())) {
      await installBundledPiMcpAdapter()
    }
    // Keep a stable, credential-free Pi config set at the same level as the
    // Claude Code and Codex homes. Each conversation still gets an isolated
    // runs/<hash> directory containing its provider credentials and sessions.
    await ensurePiScopedBaseConfigFiles(scope)
    const proxyTarget = baseUrl && (apiKey || freeRuntime)
      ? registerCodexProxyTarget({
          profile: scope.profile,
          provider,
          model,
          baseUrl,
          apiKey,
          apiMode,
          reasoningEffort,
          agentId: tool.id,
          agentSessionId: isolatedInput.agentSessionId,
          chatSessionId: isolatedInput.sessionId,
        })
      : null
    const piBaseUrl = proxyTarget?.baseUrl || baseUrl
    const piApiKey = proxyTarget?.token || apiKey
    const sessionsDir = join(rootDir, 'sessions')
    const dynamicPromptPath = join(rootDir, PI_DYNAMIC_PROMPT_FILE)
    const studioExtensionPath = join(rootDir, PI_STUDIO_EXTENSION_FILE)
    await mkdir(sessionsDir, { recursive: true })
    await writeRuntimeFile('studio_extension', PI_STUDIO_EXTENSION_FILE, piStudioRuntimeExtension())
    await writeRuntimeFile('dynamic_prompt', PI_DYNAMIC_PROMPT_FILE, '')
    await writeRuntimeFile('settings', 'settings.json', piSettingsConfig(settings, studioExtensionPath))
    await writeRuntimeFile('models', 'models.json', piModelsConfig({
      baseUrl: piBaseUrl,
      apiKey: piApiKey,
      apiMode,
      model,
      profile: scope.profile,
      provider,
      reasoningEffort,
    }))
    if (proxyTarget) {
      const proxyTargetPath = join(rootDir, PI_PROXY_TARGET_FILE)
      await atomicWritePrivateFile(proxyTargetPath, await serializePiProxyTarget({
        profile: scope.profile,
        provider,
        model,
        baseUrl,
        apiMode,
        reasoningEffort,
        agentId: tool.id,
        agentSessionId: isolatedInput.agentSessionId,
        chatSessionId: isolatedInput.sessionId,
      }, apiKey, proxyTarget.token))
      files.push({ key: 'proxy_target', path: PI_PROXY_TARGET_FILE, absolutePath: proxyTargetPath })
    }
    await writeRuntimeFile('mcp', 'mcp.json', piMcpConfig(
      scope.profile,
      await safeReadFile(getLiveConfigFileDefinition(tool.id, 'mcp')?.absolutePath || ''),
      await safeReadFile(getScopedConfigFileDefinition(tool.id, 'mcp', scope)?.absolutePath || ''),
    ))
    const piInstructions = [
      scopedSystemPrompt.trim(),
      (await safeReadFile(getLiveConfigFileDefinition(tool.id, 'agents')?.absolutePath || ''))?.trim() || '',
      (await safeReadFile(getScopedConfigFileDefinition(tool.id, 'agents', scope)?.absolutePath || ''))?.trim() || '',
    ].filter((value, index, values) => value && values.indexOf(value) === index)
    await writeRuntimeFile('prompt', 'APPEND_SYSTEM.md', `${piInstructions.join('\n\n')}\n`)
    env = {
      PI_CODING_AGENT_DIR: rootDir,
      PI_CODING_AGENT_SESSION_DIR: sessionsDir,
      HERMES_PI_DYNAMIC_PROMPT_FILE: dynamicPromptPath,
    }
    args = [
      ...(input.piOutputMode === 'rpc' ? ['--mode', 'rpc'] : []),
      '--provider', PI_PROVIDER_ID,
      '--model', model,
      ...(input.agentNativeSessionId ? ['--session-id', input.agentNativeSessionId] : []),
      '--session-dir', sessionsDir,
      '--append-system-prompt', join(rootDir, 'APPEND_SYSTEM.md'),
      ...(input.piOutputMode === 'rpc'
        ? [input.approveProjectConfig === true ? '--approve' : '--no-approve']
        : []),
    ]
  } else if (tool.id === 'grok') {
    const proxyTarget = baseUrl && (apiKey || freeRuntime)
      ? registerCodexProxyTarget({
          profile: scope.profile,
          provider,
          model,
          baseUrl,
          apiKey,
          apiMode,
          reasoningEffort,
          agentId: tool.id,
          agentSessionId: isolatedInput.agentSessionId,
          chatSessionId: isolatedInput.sessionId,
        })
      : null
    const capabilities = getModelRuntimeCapabilities({
      profile: scope.profile,
      provider,
      model,
      ...(provider === 'custom' || provider.startsWith('custom:') ? { fallbackContextLength: 128_000 } : {}),
    })
    const baseConfigRoot = getScopedConfigRoot(tool.id, scope)
    const globalGrokHome = process.env.GROK_HOME?.trim() || join(getGlobalConfigHome(), '.grok')
    const globalInstructions = await safeReadFile(join(globalGrokHome, 'AGENTS.md')) || ''
    const scopedInstructions = await safeReadFile(join(baseConfigRoot, 'AGENTS.md')) || ''
    const globalGrokConfig = await safeReadFile(getLiveConfigFileDefinition(tool.id, 'config')?.absolutePath || '')
    const scopedGrokConfig = await safeReadFile(join(baseConfigRoot, 'config.toml'))
    const prepared = await prepareScopedGrokRuntime({
      sourceHome: globalGrokHome,
      rootDir,
      provider,
      model,
      displayName: displayNameForModel(model),
      proxyBaseUrl: proxyTarget?.baseUrl || baseUrl,
      contextWindow: capabilities.contextWindow,
      outputLimit: capabilities.outputLimit,
      reasoningEffort,
      systemPrompt: scopedSystemPrompt,
      userInstructions: [globalInstructions.trim(), scopedInstructions.trim()]
        .filter((value, index, values) => value && values.indexOf(value) === index)
        .join('\n\n'),
      settingsContent: [globalGrokConfig, scopedGrokConfig].filter(Boolean).join('\n\n'),
      managedMcpToml: codexMcpConfigToml(
        scope.profile,
        'grok',
        globalGrokConfig,
        scopedGrokConfig,
      ),
    })
    files.push(...prepared.files)
    env = {
      GROK_HOME: rootDir,
      [GROK_API_KEY_ENV]: proxyTarget?.token || apiKey,
    }
    args = [
      '--model', GROK_PROVIDER_ID,
      '--always-approve',
      '--no-auto-update',
      ...(reasoningEffort ? ['--reasoning-effort', reasoningEffort] : []),
    ]
  } else if (tool.id === 'dsh') {
    const proxyTarget = registerCodexProxyTarget({
      profile: scope.profile, provider, model, baseUrl, apiKey, apiMode, reasoningEffort,
      agentId: tool.id, agentSessionId: isolatedInput.agentSessionId, chatSessionId: isolatedInput.sessionId,
    })
    const capabilities = getModelRuntimeCapabilities({ profile: scope.profile, provider, model })
    const prepared = await prepareDshRuntime({
      ...await dshHost.runtimeInput(),
      sharedSkills: join(getGlobalConfigHome(), '.agents', 'skills'),
      rootDir, systemPrompt: scopedSystemPrompt, model, baseUrl: proxyTarget.baseUrl,
      contextWindow: capabilities.contextWindow, outputLimit: capabilities.outputLimit,
      imageInput: capabilities.input.includes('image'),
      reasoningEffort,
      managedMcp: getCodingAgentManagedMcpServerConfigs('dsh', scope.profile),
    })
    files.push(...prepared.files)
    args = prepared.args
    env = { ...prepared.env, [DSH_API_KEY_ENV]: proxyTarget.token }
  } else {
    const proxyTarget = baseUrl && (apiKey || freeRuntime)
      ? registerCodexProxyTarget({
          profile: scope.profile,
          provider,
          model,
          baseUrl,
          apiKey,
          apiMode,
          reasoningEffort,
          agentId: tool.id,
          agentSessionId: isolatedInput.agentSessionId,
          chatSessionId: isolatedInput.sessionId,
        })
      : null
    const baseRuntime = await ensureOpenCodeScopedBaseConfigFiles(scope, scopedSystemPrompt, workspaceDir)
    const configPath = join(rootDir, OPENCODE_CONFIG_FILE)
    const promptPath = join(rootDir, 'AGENTS.md')
    await writeManagedPromptFile(promptPath, scopedSystemPrompt, '')
    const runtimeConfig = opencodeRuntimeConfig(scope.profile, {
      provider,
      model,
      baseUrl: proxyTarget?.baseUrl || baseUrl,
      systemPrompt: promptPath,
    })
    await writeFile(configPath, runtimeConfig, 'utf-8')
    files.push(
      { key: 'config', path: OPENCODE_CONFIG_FILE, absolutePath: configPath },
      { key: 'agents', path: 'AGENTS.md', absolutePath: promptPath },
    )
    env = openCodeRuntimeEnv({
      configDir: baseRuntime.rootDir,
      databasePath: join(rootDir, OPENCODE_DATABASE_FILE),
      runtimeConfig,
      apiKey: proxyTarget?.token || apiKey,
    })
    args = ['--model', `${OPENCODE_PROVIDER_ID}/${model}`]
  }

  const chatSessionId = String(isolatedInput.sessionId || '').trim()
  if (chatSessionId) env[HERMES_STUDIO_SESSION_ENV_KEY] = chatSessionId
  let shellCommand = buildLaunchShellCommand({
    workspaceDir,
    env,
    command: tool.command,
    args,
  })
  const launcherPath = await writeLauncherScript({
    rootDir,
    workspaceDir,
    env,
    command: tool.command,
    args,
  })
  files.push({
    key: 'launcher',
    path: process.platform === 'win32' ? WINDOWS_LAUNCHER_FILE : POSIX_LAUNCHER_FILE,
    absolutePath: launcherPath,
  })
  shellCommand = buildLauncherShellCommand(workspaceDir, launcherPath)

  return {
    agentId: tool.id,
    mode,
    profile: scope.profile,
    provider,
    model,
    apiMode,
    rootDir,
    workspaceDir,
    command: tool.command,
    args,
    env,
    shellCommand,
    files,
    promptFile: tool.id === 'claude-code'
      ? join(rootDir, 'hermes-rules.md')
      : tool.id === 'grok' || tool.id === 'dsh'
        ? join(rootDir, 'AGENTS.md')
        : tool.id === 'opencode'
          ? join(rootDir, 'AGENTS.md')
        : undefined,
    reasoningEffort,
  }
}

export async function startCodingAgentRun(id: string, input: CodingAgentLaunchInput & { sessionId: string }, state?: SessionState): Promise<CodingAgentRunStartResult> {
  const release = beginAgentPreparation(id)
  try { return await startCodingAgentRunInternal(id, input, state) } finally { release() }
}

async function startCodingAgentRunInternal(
  id: string,
  input: CodingAgentLaunchInput & { sessionId: string },
  state?: SessionState,
): Promise<CodingAgentRunStartResult> {
  const sessionId = String(input.sessionId || '').trim()
  if (!sessionId) {
    const err = new Error('sessionId is required')
    ;(err as any).status = 400
    throw err
  }
  const existingSession = getSession(sessionId)
  const agentPreset = id === 'dsh' ? await dshHost.presets.forSession(input.agentPreset, existingSession?.agent_preset) : undefined
  const sessionSource = input.sessionSource === 'global_agent'
    ? 'global_agent'
    : input.sessionSource === 'group_chat'
      ? 'group_chat'
    : input.sessionSource === 'workflow'
      ? 'workflow'
      : 'coding_agent'
  const existingAgentSessionId = existingSession?.agent_session_id || ''
  const resolvedInput = await resolveStoredProviderLaunchInput(input, existingSession)
  const requestedMode = resolvedInput.mode === 'global' ? 'global' : 'scoped'
  const requestedProvider = String(resolvedInput.provider || '').trim().toLowerCase()
  assertScopedCodingAgentProviderAllowed(requestedMode, requestedProvider)
  if (requestedMode !== 'global' && (!String(resolvedInput.baseUrl || '').trim() || (!String(resolvedInput.apiKey || '').trim() && requestedProvider !== OPENCODE_FREE_PROVIDER))) {
    const err = new Error('Coding agent provider credentials are missing. Re-select the provider/model or update the provider API key before continuing this session.')
    ;(err as any).status = 400
    throw err
  }
  const agentSessionId = resolvedInput.agentSessionId || existingAgentSessionId || makeAgentSessionId()
  const canResumeNativeSession = existingSession
    ? storedCodingAgentMode(existingSession) === requestedMode &&
      (existingSession.agent === persistedAgentId(id) || !existingSession.agent) &&
      (requestedMode === 'global' || (
        String(existingSession.provider || '').trim() === String(resolvedInput.provider || '').trim() &&
        String(existingSession.model || '').trim() === String(resolvedInput.model || '').trim() &&
        (!String(existingSession.api_mode || '').trim() || String(existingSession.api_mode || '').trim() === String(resolvedInput.apiMode || '').trim())
      ))
    : false
  const existingNativeSessionId = canResumeNativeSession ? existingSession?.agent_native_session_id || '' : ''
  const agentNativeSessionId = resolvedInput.agentNativeSessionId || existingNativeSessionId || (id === 'claude-code' || id === 'pi' || id === 'grok' ? randomUUID() : '')
  const launch = await prepareCodingAgentLaunch(id, {
    ...resolvedInput,
    sessionId,
    agentSessionId,
    agentNativeSessionId,
    isolateSettings: true,
    piOutputMode: id === 'pi' ? 'rpc' : undefined,
  })
  const runtimeMcpFile = launch.files.find(file => file.key === (id === 'dsh' ? 'cordis.patch.yml' : id === 'codex' || id === 'grok' || id === 'opencode' ? 'config' : 'mcp'))
  const runtimeMcpPath = runtimeMcpFile?.absolutePath
    || (id === 'codex' || id === 'grok' || id === 'opencode'
      ? join(launch.rootDir, id === 'opencode' ? OPENCODE_CONFIG_FILE : 'config.toml')
      : id === 'pi'
        ? join(launch.rootDir, 'mcp.json')
        : '')
  if (runtimeMcpPath) {
    try {
      await isolateUnhealthyRuntimeMcpServers(id, runtimeMcpPath)
    } catch (err) {
      logger.warn({ err, agentId: id, runtimeMcpPath }, '[coding-agent-mcp] runtime isolation failed open')
    }
  }
  const commandExecutionEnv = {
    ...(await commandEnv()),
    ...launch.env,
  }
  const runtimeCommand = process.platform === 'win32'
    ? await resolveCommandForExecution(launch.command, commandExecutionEnv)
    : launch.command
  const runtimeEnv = launch.agentId === 'pi' ? launch.env : commandExecutionEnv
  const persistedProvider = String(resolvedInput.provider || launch.provider || '').trim() || launch.provider
  const started = codingAgentRunManager.start({
    agentSessionId,
    agentId: launch.agentId,
    mode: launch.mode,
    profile: launch.profile,
    provider: persistedProvider,
    model: launch.model,
    apiMode: launch.apiMode,
    sessionId,
    agentNativeSessionId,
    nativeResume: Boolean(existingNativeSessionId),
    command: runtimeCommand,
    args: launch.args,
    shellCommand: launch.shellCommand,
    workspaceDir: launch.workspaceDir,
    env: runtimeEnv,
    promptFile: launch.promptFile,
    state,
    reasoningEffort: launch.reasoningEffort,
    agentPreset,
    sessionSource: sessionSource === 'global_agent' || sessionSource === 'workflow' || sessionSource === 'group_chat'
      ? sessionSource
      : undefined,
  })
  updateSession(sessionId, {
    source: sessionSource,
    agent: persistedAgentId(launch.agentId),
    agent_mode: launch.mode,
    ...(agentPreset ? { agent_preset: agentPreset } : {}),
    agent_session_id: agentSessionId,
    agent_native_session_id: agentNativeSessionId,
    model: launch.model,
    provider: persistedProvider,
    api_mode: launch.apiMode || '',
    workspace: launch.workspaceDir,
  })
  return {
    ...launch,
    provider: persistedProvider,
    agentSessionId,
    sessionId,
    pid: started.pid,
  }
}

export async function compactStoredCodingAgentSession(
  sessionId: string,
  profile: string,
): Promise<{ compacted: boolean; beforeTokens?: number | null; afterTokens?: number | null }> {
  const session = getSession(sessionId)
  if (!session || (session.agent !== 'codex' && session.agent !== 'claude')) {
    throw new Error('Coding agent session not found or is not a Codex/Claude Code session')
  }
  if (session.agent !== 'codex') {
    throw new Error('Claude Code compact requires an active session run')
  }
  const nativeSessionId = String(session.agent_native_session_id || '').trim()
  if (!nativeSessionId) {
    throw new Error('Codex session has no native thread to compact')
  }
  const resolved = await resolveStoredProviderLaunchInput({
    sessionId,
    profile,
    mode: session.agent_mode === 'global' ? 'global' : 'scoped',
    workspace: session.workspace || undefined,
    agentNativeSessionId: session.agent_native_session_id || undefined,
    agentSessionId: session.agent_session_id || undefined,
  }, session)
  const launch = await prepareCodingAgentLaunch('codex', {
    ...resolved,
    sessionId,
    profile,
    isolateSettings: true,
  })
  const launchEnv = {
    ...(await commandEnv()),
    ...launch.env,
  }
  const command = process.platform === 'win32'
    ? await resolveCommandForExecution(launch.command, launchEnv)
    : launch.command
  return compactCodexThread({
    command,
    env: launchEnv,
    workspaceDir: launch.workspaceDir,
  }, nativeSessionId)
}

export function sendCodingAgentRunInput(
  sessionId: string,
  input: string,
  systemPrompt?: string,
  images: CodingAgentImageInput[] = [],
  storageInput?: string,
): { runId: string; messageId?: number } {
  return codingAgentRunManager.send(sessionId, input, { systemPrompt, images, storageInput })
}

export function stopCodingAgentRun(sessionId: string): { stopped: boolean } {
  return { stopped: codingAgentRunManager.stop(sessionId) }
}

export function invalidateCodingAgentProviderRuntime(profileInput: string, providerInput: string): {
  invalidatedRuns: number
  deferredRuns: number
} {
  const profile = normalizeScopeSegment(profileInput, 'default', 'profile')
  const providerIdentity = normalizeProviderIdentity(providerInput)
  const result = codingAgentRunManager.invalidateMatching(launch => (
    launch.profile === profile && launch.provider === providerIdentity
  ))
  return { invalidatedRuns: result.invalidated, deferredRuns: result.deferred }
}

export async function openCodingAgentNativeTerminal(id: string, input: CodingAgentLaunchInput): Promise<CodingAgentNativeLaunchResult> {
  const launch = await prepareCodingAgentLaunch(id, input)
  const terminal = await openNativeTerminal(launch.shellCommand)
  return {
    ...launch,
    nativeTerminal: true,
    terminal,
  }
}
