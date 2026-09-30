import { randomUUID } from 'node:crypto'
import {
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DEFAULT_TOOL_APPROVAL_TIMEOUT_MS } from '../config'
import type {
  AgentToolApprovalChoice,
  AgentToolApprovalRequest,
  AgentToolAuthorizationDecision,
  AgentToolAuthorizer,
  AgentToolContext,
} from './types'

const MAX_APPROVAL_PREVIEW_CHARS = 4_000
const MAX_TRACKED_APPROVAL_SESSIONS = 1_024
const APPROVAL_CHOICES: AgentToolApprovalChoice[] = ['once', 'session', 'always', 'deny']

export interface ToolApprovalRequirement {
  key: string
  command: string
  description: string
}

export interface EkkoToolApprovalServiceOptions {
  configPath: string
  enabled?: boolean
  timeoutMs?: number
}

interface JsonRecord {
  [key: string]: unknown
}

interface DangerousCommandRule {
  key: string
  description: string
  matches: (command: string, executable: string, args: string[]) => boolean
}

const DANGEROUS_COMMAND_RULES: DangerousCommandRule[] = [
  commandRule('terminal:delete', 'deletes files or directories', ['rm', 'rmdir', 'unlink', 'shred', 'del', 'erase']),
  commandRule('terminal:privilege', 'runs with elevated privileges', ['sudo', 'su', 'doas']),
  commandRule('terminal:filesystem', 'changes disks, filesystems, ownership, or broad permissions', [
    'mkfs',
    'fdisk',
    'parted',
    'diskutil',
    'dd',
    'chown',
    'chgrp',
  ]),
  commandRule('terminal:process', 'stops or forcefully controls processes', [
    'kill',
    'killall',
    'pkill',
    'taskkill',
  ]),
  commandRule('terminal:system-service', 'stops, restarts, disables, or powers down system services', [
    'shutdown',
    'reboot',
    'poweroff',
    'halt',
  ]),
  commandRule('terminal:shell', 'executes arbitrary shell source', [
    'sh',
    'bash',
    'zsh',
    'dash',
    'ksh',
    'fish',
    'cmd',
    'powershell',
    'pwsh',
    'osascript',
  ]),
  {
    key: 'terminal:inline-code',
    description: 'executes inline source code through a language runtime',
    matches: (_command, executable, args) => (
      ['node', 'nodejs', 'python', 'python3', 'py', 'ruby', 'perl', 'php'].includes(executable) &&
      args.some(argument => ['-c', '-e', '--eval', '-command', '-encodedcommand'].includes(argument.toLowerCase()))
    ),
  },
  {
    key: 'terminal:git-destructive',
    description: 'can discard local work or rewrite Git history',
    matches: (command, executable) => executable === 'git' && (
      /\bgit\s+reset\s+--h(?:a(?:r(?:d)?)?)?\b/i.test(command) ||
      /\bgit\s+clean\b[^;&|\n]*\s-[a-z]*f/i.test(command) ||
      /\bgit\s+push\b[^;&|\n]*(?:--force(?:-with-lease)?|-f\b)/i.test(command) ||
      /\bgit\s+branch\b[^;&|\n]*(?:-D\b|--delete\b[^;&|\n]*--force\b|--force\b[^;&|\n]*--delete\b)/i.test(command)
    ),
  },
  {
    key: 'terminal:container-lifecycle',
    description: 'stops, restarts, kills, or removes containers',
    matches: (command, executable) => (
      ['docker', 'podman', 'docker-compose'].includes(executable) &&
      /\b(?:stop|restart|kill|down|rm|rmi|system\s+prune|volume\s+rm)\b/i.test(command)
    ),
  },
  {
    key: 'terminal:service-control',
    description: 'stops, restarts, disables, or unloads a service',
    matches: (command, executable) => (
      ['systemctl', 'service', 'launchctl'].includes(executable) &&
      /\b(?:stop|restart|disable|mask|unload|bootout|kickstart|remove)\b/i.test(command)
    ),
  },
  {
    key: 'terminal:database-destructive',
    description: 'contains a destructive database operation',
    matches: command => (
      /\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b/i.test(command) ||
      /\bTRUNCATE\s+(?:TABLE\s+)?\S+/i.test(command) ||
      /\bDELETE\s+FROM\b(?![^\n]*\bWHERE\b)/i.test(command)
    ),
  },
  {
    key: 'terminal:remote-shell',
    description: 'opens a remote shell or executes a command on a remote host',
    matches: (_command, executable) => ['ssh', 'mosh'].includes(executable),
  },
  {
    key: 'terminal:package-publish',
    description: 'publishes or removes a package from a registry',
    matches: (command, executable) => (
      ['npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'twine'].includes(executable) &&
      /\b(?:publish|unpublish|yank)\b/i.test(command)
    ),
  },
]

/**
 * Central authorization state for Ekko tool calls.
 *
 * Session approvals stay in memory. Permanent approvals are the only runtime
 * setting read from and written back to the global Ekko config.
 */
export class EkkoToolApprovalService {
  readonly authorize: AgentToolAuthorizer
  private readonly configPath: string
  private readonly enabled: boolean
  private readonly timeoutMs: number
  private readonly permanentAllow = new Set<string>()
  private readonly sessionAllow = new Map<string, Set<string>>()

  constructor(options: EkkoToolApprovalServiceOptions) {
    this.configPath = options.configPath
    this.enabled = options.enabled !== false
    this.timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TOOL_APPROVAL_TIMEOUT_MS)
    for (const key of readPermanentAllowlist(this.configPath)) this.permanentAllow.add(key)
    this.authorize = this.authorizeToolCall.bind(this)
  }

  permanentAllowlist(): string[] {
    return [...this.permanentAllow].sort()
  }

  sessionAllowlist(sessionId: string): string[] {
    return [...(this.sessionAllow.get(sessionId) || [])].sort()
  }

  clearSession(sessionId: string): void {
    this.sessionAllow.delete(sessionId)
  }

  private async authorizeToolCall(
    toolName: string,
    input: Record<string, unknown>,
    context: AgentToolContext = {},
  ): Promise<AgentToolAuthorizationDecision> {
    if (!this.enabled) return { approved: true, scope: 'safe' }
    const requirement = toolApprovalRequirement(toolName, input)
    if (!requirement) return { approved: true, scope: 'safe' }

    if (this.permanentAllow.has(requirement.key)) {
      return approvedDecision('always', requirement)
    }

    const sessionId = String(context.sessionId || '').trim()
    if (sessionId && this.sessionAllow.get(sessionId)?.has(requirement.key)) {
      this.touchSession(sessionId)
      return approvedDecision('session', requirement)
    }

    if (!context.requestToolApproval) {
      return deniedDecision(
        requirement,
        `Tool call requires approval, but no interactive approval handler is available: ${requirement.description}.`,
      )
    }

    const request: AgentToolApprovalRequest = {
      approvalId: randomUUID(),
      toolName,
      key: requirement.key,
      command: requirement.command,
      description: requirement.description,
      choices: [...APPROVAL_CHOICES],
      allowPermanent: true,
      timeoutMs: this.timeoutMs,
    }

    let choice: AgentToolApprovalChoice
    try {
      choice = normalizeApprovalChoice(await context.requestToolApproval(request))
    } catch (error) {
      return deniedDecision(
        requirement,
        `Tool approval failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    if (choice === 'deny') {
      return deniedDecision(requirement, `User denied the tool call: ${requirement.description}.`)
    }
    if (choice === 'session') {
      if (!sessionId) {
        return deniedDecision(requirement, 'Session approval requires a session id.')
      }
      this.rememberSessionApproval(sessionId, requirement.key)
      return approvedDecision('session', requirement)
    }
    if (choice === 'always') {
      try {
        persistPermanentApproval(this.configPath, requirement.key)
        this.permanentAllow.add(requirement.key)
      } catch (error) {
        return deniedDecision(
          requirement,
          `Permanent approval could not be saved: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      return approvedDecision('always', requirement)
    }
    return approvedDecision('once', requirement)
  }

  private rememberSessionApproval(sessionId: string, key: string): void {
    const approvals = this.sessionAllow.get(sessionId) || new Set<string>()
    approvals.add(key)
    this.sessionAllow.delete(sessionId)
    this.sessionAllow.set(sessionId, approvals)
    if (this.sessionAllow.size > MAX_TRACKED_APPROVAL_SESSIONS) {
      const oldest = this.sessionAllow.keys().next().value
      if (oldest) this.sessionAllow.delete(oldest)
    }
  }

  private touchSession(sessionId: string): void {
    const approvals = this.sessionAllow.get(sessionId)
    if (!approvals) return
    this.sessionAllow.delete(sessionId)
    this.sessionAllow.set(sessionId, approvals)
  }
}

export function toolApprovalRequirement(
  toolName: string,
  input: Record<string, unknown>,
): ToolApprovalRequirement | undefined {
  if (toolName === 'ekko_repair_database' && input.strategy === 'rebuild') {
    return {
      key: 'ekko:database-rebuild',
      command: 'ekko_repair_database strategy=rebuild',
      description: 'quarantines and rebuilds the persistent Ekko database',
    }
  }
  if (toolName === 'code_exec') {
    const language = String(input.language || '').trim().toLowerCase()
    if (language !== 'node' && language !== 'python') return undefined
    const code = String(input.code || '')
    return {
      key: `code_exec:${language}`,
      command: limitPreview(`${language}\n${code}`),
      description: `executes arbitrary ${language === 'node' ? 'Node.js' : 'Python'} code`,
    }
  }
  if (toolName !== 'terminal_exec') return undefined

  const command = String(input.command || '').trim()
  if (!command) return undefined
  const args = Array.isArray(input.args) ? input.args.map(value => String(value)) : []
  const normalized = normalizeTerminalInvocation(command, args)
  const display = formatCommand(normalized.command, normalized.args)
  const effective = unwrapTerminalInvocation(normalized.command, normalized.args)
  const executable = executableName(effective.command)
  const rule = DANGEROUS_COMMAND_RULES.find(candidate =>
    candidate.matches(display, executable, effective.args),
  )
  if (!rule) return undefined
  return {
    key: rule.key,
    command: limitPreview(display),
    description: rule.description,
  }
}

function unwrapTerminalInvocation(
  command: string,
  args: string[],
): { command: string; args: string[] } {
  let currentCommand = command
  let currentArgs = [...args]
  for (let depth = 0; depth < 4; depth += 1) {
    const executable = executableName(currentCommand)
    if (executable === 'env') {
      while (
        currentArgs.length &&
        (currentArgs[0].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(currentArgs[0]))
      ) {
        currentArgs.shift()
      }
    } else if (executable === 'command' || executable === 'exec' || executable === 'nohup') {
      while (currentArgs[0]?.startsWith('-')) currentArgs.shift()
    } else if (executable === 'nice') {
      while (currentArgs.length && (
        currentArgs[0].startsWith('-') ||
        /^-?\d+$/.test(currentArgs[0])
      )) {
        currentArgs.shift()
      }
    } else {
      break
    }
    const nextCommand = currentArgs.shift()
    if (!nextCommand) break
    currentCommand = nextCommand
  }
  return { command: currentCommand, args: currentArgs }
}

function commandRule(
  key: string,
  description: string,
  executables: string[],
): DangerousCommandRule {
  const allowed = new Set(executables)
  return {
    key,
    description,
    matches: (_command, executable) => allowed.has(executable),
  }
}

function normalizeTerminalInvocation(
  command: string,
  args: string[],
): { command: string; args: string[] } {
  if (args.length || !/\s/.test(command)) return { command, args }
  const parts = splitCommandLine(command)
  return parts.length > 1
    ? { command: parts[0], args: parts.slice(1) }
    : { command, args }
}

function splitCommandLine(command: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let escaped = false
  for (const character of command.trim()) {
    if (escaped) {
      current += character
      escaped = false
    } else if (character === '\\' && process.platform !== 'win32') {
      escaped = true
    } else if (quote) {
      if (character === quote) quote = undefined
      else current += character
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (/\s/.test(character)) {
      if (current) {
        parts.push(current)
        current = ''
      }
    } else {
      current += character
    }
  }
  if (escaped) current += '\\'
  if (current) parts.push(current)
  return parts
}

function executableName(command: string): string {
  return basename(command).toLowerCase().replace(/\.(?:exe|cmd|bat)$/i, '')
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map(formatCommandToken).join(' ')
}

function formatCommandToken(value: string): string {
  return /^[a-z0-9_./:@%+=,-]+$/i.test(value) ? value : JSON.stringify(value)
}

function limitPreview(value: string): string {
  if (value.length <= MAX_APPROVAL_PREVIEW_CHARS) return value
  return `${value.slice(0, MAX_APPROVAL_PREVIEW_CHARS)}\n… (truncated)`
}

function normalizeApprovalChoice(value: unknown): AgentToolApprovalChoice {
  return APPROVAL_CHOICES.includes(value as AgentToolApprovalChoice)
    ? value as AgentToolApprovalChoice
    : 'deny'
}

function approvedDecision(
  scope: 'once' | 'session' | 'always',
  requirement: ToolApprovalRequirement,
): AgentToolAuthorizationDecision {
  return {
    approved: true,
    scope,
    key: requirement.key,
    description: requirement.description,
  }
}

function deniedDecision(
  requirement: ToolApprovalRequirement,
  error: string,
): AgentToolAuthorizationDecision {
  return {
    approved: false,
    scope: 'denied',
    key: requirement.key,
    description: requirement.description,
    error,
  }
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function readPermanentAllowlist(configPath: string): string[] {
  try {
    const config = parseJsonRecord(readFileSync(configPath, 'utf8'))
    const tools = parseJsonRecord(config.tools)
    const approvals = parseJsonRecord(tools.approvals)
    return Array.isArray(approvals.permanentAllow)
      ? approvals.permanentAllow
        .map(value => String(value || '').trim())
        .filter(Boolean)
      : []
  } catch {
    return []
  }
}

function persistPermanentApproval(configPath: string, key: string): void {
  const config = parseJsonRecord(readFileSync(configPath, 'utf8'))
  const tools = parseJsonRecord(config.tools)
  const approvals = parseJsonRecord(tools.approvals)
  const permanentAllow = new Set(
    Array.isArray(approvals.permanentAllow)
      ? approvals.permanentAllow.map(value => String(value || '').trim()).filter(Boolean)
      : [],
  )
  permanentAllow.add(key)
  approvals.enabled = approvals.enabled !== false
  approvals.timeoutMs = positiveInteger(approvals.timeoutMs, DEFAULT_TOOL_APPROVAL_TIMEOUT_MS)
  approvals.permanentAllow = [...permanentAllow].sort()
  tools.approvals = approvals
  config.tools = tools

  const temporaryPath = join(dirname(configPath), `.config-${randomUUID()}.tmp`)
  const serialized = `${JSON.stringify(config, null, 2)}\n`
  try {
    writeFileSync(temporaryPath, serialized, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    try {
      renameSync(temporaryPath, configPath)
    } catch {
      // Windows may not replace an existing destination with rename. Keep the
      // atomic path where supported and fall back to a direct structured write.
      writeFileSync(configPath, serialized, { encoding: 'utf8', mode: 0o600 })
    }
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}

function parseJsonRecord(value: unknown): JsonRecord {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return parsed as JsonRecord
}
