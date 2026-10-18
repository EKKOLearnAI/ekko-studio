import {
  AgentRuntime,
  EkkoAgentSetup,
  EkkoFileLogger,
  MemoryService,
  setupEkkoAgent,
  DEFAULT_EKKO_JEV_CONFIG,
  type EkkoJevConfig,
  type AgentRuntimeRunInput,
  type AgentRuntimeRunResult,
  type AgentRuntimeBoundaryInterruptRequest,
  type AgentRuntimeBoundaryInterruptResult,
  type AgentRuntimeContextEstimate,
  type AgentRuntimeOptions,
  type EkkoConfig,
  type EkkoConfigPatch,
} from '../../../../../ekko-agent/src'
import { config } from '../../studio/public/config'
import { logger } from '../../studio/public/logging'
import { getJevRuntimeConfig } from '../../studio/public/jev'
import {
  getProfilesBaseDir,
  listProfileNames,
} from '../../studio/public/profile-config'
import { denyPendingEkkoToolApprovals } from './approvals'
import { cancelPendingEkkoClarifications } from './clarifications'

export interface GlobalEkkoAgentOptions {
  setup: EkkoAgentSetup
  profile?: string
  memory?: MemoryService | false
  /** Installation-wide values applied before this global agent is created. */
  config?: EkkoConfigPatch
}

export class GlobalEkkoAgent {
  readonly createdAt = Date.now()
  lastUsedAt = this.createdAt
  runCount = 0
  private readonly options: GlobalEkkoAgentOptions
  private readonly setup: EkkoAgentSetup
  private readonly skillDirectory: string
  private readonly logDirectory: string
  private readonly workspaceDirectory: string
  private fileLogger: EkkoFileLogger
  private runtime?: AgentRuntime
  private activeRuns = 0
  private runtimeRefreshPending = false
  private readonly memory?: MemoryService
  private readonly memoryDatabasePath?: string

  constructor(options: GlobalEkkoAgentOptions) {
    this.options = options
    this.setup = options.setup
    if (options.config) this.setup.config.update(options.config)
    const profileLayout = this.setup.profile(options.profile)
    this.skillDirectory = profileLayout.skillDirectory
    this.logDirectory = profileLayout.logDirectory
    this.workspaceDirectory = profileLayout.workspaceDirectory
    this.fileLogger = this.createFileLogger()
    this.memory = options.memory === false ? undefined : options.memory ?? this.setup.memory
    this.memoryDatabasePath = this.memory === this.setup.memory
      ? this.setup.database.databasePath
      : undefined
  }

  async run(input: AgentRuntimeRunInput): Promise<AgentRuntimeRunResult> {
    this.lastUsedAt = Date.now()
    this.runCount += 1
    this.activeRuns += 1
    try {
      const runtime = this.runtimeInstance(await this.jevRuntimeConfig())
      return await runtime.run(this.withDefaultWorkspace(input))
    } finally {
      this.activeRuns -= 1
      this.applyPendingRuntimeRefresh()
      reloadGlobalEkkoSetupAfterRecovery()
    }
  }

  async runIsolated(
    options: Omit<AgentRuntimeOptions, 'logWriter' | 'logProfile'>,
    input: AgentRuntimeRunInput,
  ): Promise<AgentRuntimeRunResult> {
    this.activeRuns += 1
    try {
      const runtime = this.setup.createRuntime({
        ...options,
        jev: await this.jevRuntimeConfig(),
        profile: this.options.profile || 'default',
        memory: options.memory ?? false,
        logWriter: this.fileLogger,
        logProfile: this.options.profile || 'default',
      })
      return await runtime.run(input)
    } finally {
      this.activeRuns -= 1
      reloadGlobalEkkoSetupAfterRecovery()
    }
  }

  async estimateContext(input: AgentRuntimeRunInput): Promise<AgentRuntimeContextEstimate> {
    return this.runtimeInstance().estimateContext(this.withDefaultWorkspace(input))
  }

  sessionWorkspaceDirectory(sessionId: string): string {
    return this.setup.directories.sessionWorkspaceDirectory(this.options.profile || 'default', sessionId)
  }

  hasBackgroundTasks(sessionId?: string): boolean {
    return this.runtime?.hasBackgroundTasks(sessionId) ?? false
  }

  isIdleForSetupReload(): boolean {
    return this.activeRuns === 0 && !this.hasBackgroundTasks()
  }

  async abortBackgroundTasks(sessionId?: string): Promise<number> {
    const count = await (this.runtime?.abortBackgroundTasks(sessionId) ?? 0)
    this.applyPendingRuntimeRefresh()
    reloadGlobalEkkoSetupAfterRecovery()
    return count
  }

  requestBoundaryInterrupt(
    input: AgentRuntimeBoundaryInterruptRequest,
  ): AgentRuntimeBoundaryInterruptResult {
    return this.runtime?.requestBoundaryInterrupt(input) ?? { status: 'not_running' }
  }

  close(): void {
    void this.runtime?.abortBackgroundTasks()
    this.runtime = undefined
  }

  refreshRuntime(): 'refreshed' | 'deferred' {
    if (this.activeRuns > 0 || this.hasBackgroundTasks()) {
      this.runtimeRefreshPending = true
      return 'deferred'
    }
    this.runtime = undefined
    this.fileLogger = this.createFileLogger()
    this.runtimeRefreshPending = false
    return 'refreshed'
  }

  status() {
    return {
      createdAt: this.createdAt,
      lastUsedAt: this.lastUsedAt,
      runCount: this.runCount,
      memoryEnabled: this.memory?.isEnabled ?? false,
      memoryDatabasePath: this.memoryDatabasePath,
      dataDirectory: this.setup.layout.rootDirectory,
      configDirectory: this.setup.layout.configDirectory,
      configPath: this.setup.layout.configPath,
      skillDirectory: this.skillDirectory,
      logDirectory: this.logDirectory,
      workspaceDirectory: this.workspaceDirectory,
      logFilePath: this.fileLogger.filePath,
      profile: this.options.profile || 'default',
      recovery: this.setup.recovery.snapshot(),
    }
  }

  readConfig(): EkkoConfig {
    return this.setup.config.read()
  }

  private runtimeInstance(jev?: EkkoJevConfig): AgentRuntime {
    this.applyPendingRuntimeRefresh()
    if (this.runtime) {
      if (jev) this.runtime.jev.configure(jev)
      return this.runtime
    }
    this.runtime = this.setup.createRuntime({
      jev: jev ?? false,
      profile: this.options.profile || 'default',
      memory: this.memory ?? false,
      logWriter: this.fileLogger,
      logProfile: this.options.profile || 'default',
    })
    return this.runtime
  }

  private async jevRuntimeConfig(): Promise<EkkoJevConfig> {
    try {
      return await getJevRuntimeConfig(this.options.profile || 'default')
    } catch {
      logger.warn('[ekko-agent] Studio JEV settings unavailable; JEV is disabled for this run')
      return { ...DEFAULT_EKKO_JEV_CONFIG }
    }
  }

  private applyPendingRuntimeRefresh(): void {
    if (!this.runtimeRefreshPending || this.activeRuns > 0 || this.hasBackgroundTasks()) return
    this.runtime = undefined
    this.fileLogger = this.createFileLogger()
    this.runtimeRefreshPending = false
  }

  private createFileLogger(): EkkoFileLogger {
    return new EkkoFileLogger({
      directory: this.logDirectory,
      maxBytes: this.setup.config.read().logging.maxBytes,
    })
  }

  private withDefaultWorkspace(input: AgentRuntimeRunInput): AgentRuntimeRunInput {
    if (input.toolContext?.workspaceRoot || input.toolContext?.cwd) return input
    const sessionId = (
      input.toolContext?.sessionId ||
      (typeof input.metadata?.session_id === 'string' ? input.metadata.session_id : '')
    ).trim()
    if (!sessionId) return input
    const workspace = this.sessionWorkspaceDirectory(sessionId)
    return {
      ...input,
      toolContext: {
        ...input.toolContext,
        cwd: workspace,
        workspaceRoot: workspace,
        workspaceId: input.toolContext?.workspaceId || workspace,
      },
    }
  }
}

export function createGlobalEkkoAgent(
  options: GlobalEkkoAgentOptions,
): GlobalEkkoAgent {
  return new GlobalEkkoAgent(options)
}

export interface SetupGlobalEkkoAgentOptions {
  baseDirectory?: string
  profiles?: string[]
  config?: EkkoConfigPatch
  env?: Record<string, string | undefined>
}

let globalEkkoSetup: EkkoAgentSetup | undefined
let globalEkkoSetupOptions: SetupGlobalEkkoAgentOptions | undefined
const globalEkkoAgents = new Map<string, GlobalEkkoAgent>()

function reloadGlobalEkkoSetupAfterRecovery(): boolean {
  if (!globalEkkoSetup?.recovery.snapshot().capabilities.database.restartRequired) return false
  if ([...globalEkkoAgents.values()].some(agent => !agent.isIdleForSetupReload())) return false

  const databasePath = globalEkkoSetup.layout.databasePath
  for (const agent of globalEkkoAgents.values()) agent.close()
  globalEkkoAgents.clear()
  globalEkkoSetup.close()
  globalEkkoSetup = undefined
  logger.info({ databasePath }, '[ekko-agent] persistent database repaired; setup will reopen automatically')
  return true
}

export function setupGlobalEkkoAgent(
  options: SetupGlobalEkkoAgentOptions = {},
): EkkoAgentSetup {
  reloadGlobalEkkoSetupAfterRecovery()
  if (globalEkkoSetup) return globalEkkoSetup
  if (!globalEkkoSetupOptions) {
    globalEkkoSetupOptions = {
      ...options,
      ...(options.profiles ? { profiles: [...options.profiles] } : {}),
      ...(options.env ? { env: { ...options.env } } : {}),
    }
  }
  const setupOptions = globalEkkoSetupOptions
  globalEkkoSetup = setupEkkoAgent({
    baseDirectory: setupOptions.baseDirectory ?? config.appHome,
    hermesRootDirectory: getProfilesBaseDir(),
    profiles: setupOptions.profiles ?? listProfileNames(),
    config: setupOptions.config,
    env: setupOptions.env,
  })
  logger.info({
    dataDirectory: globalEkkoSetup.layout.rootDirectory,
    configPath: globalEkkoSetup.layout.configPath,
    databasePath: globalEkkoSetup.layout.databasePath,
    activeDatabasePath: globalEkkoSetup.database.databasePath,
    recoveryStatus: globalEkkoSetup.recovery.snapshot().status,
    profiles: globalEkkoSetup.profiles().map(profile => profile.profile),
  }, '[ekko-agent] setup complete')
  return globalEkkoSetup
}

export function getGlobalEkkoAgent(profile = 'default'): GlobalEkkoAgent {
  const normalizedProfile = String(profile || '').trim() || 'default'
  const setup = setupGlobalEkkoAgent()
  let agent = globalEkkoAgents.get(normalizedProfile)
  if (!agent) {
    setup.ensureProfile(normalizedProfile)
    agent = createGlobalEkkoAgent({
      setup,
      profile: normalizedProfile,
    })
    globalEkkoAgents.set(normalizedProfile, agent)
  }
  return agent
}

export function hasGlobalEkkoBackgroundTasks(sessionId: string): boolean {
  for (const agent of globalEkkoAgents.values()) {
    if (agent.hasBackgroundTasks(sessionId)) return true
  }
  return false
}

export async function abortGlobalEkkoBackgroundTasks(sessionId: string): Promise<number> {
  const counts = await Promise.all(
    [...globalEkkoAgents.values()].map(agent => agent.abortBackgroundTasks(sessionId)),
  )
  return counts.reduce((sum, count) => sum + count, 0)
}

export function refreshGlobalEkkoAgentRuntimes(): { refreshed: number; deferred: number } {
  let refreshed = 0
  let deferred = 0
  for (const agent of globalEkkoAgents.values()) {
    if (agent.refreshRuntime() === 'refreshed') refreshed += 1
    else deferred += 1
  }
  return { refreshed, deferred }
}

export function closeGlobalEkkoAgent(): void {
  denyPendingEkkoToolApprovals()
  cancelPendingEkkoClarifications()
  for (const agent of globalEkkoAgents.values()) agent.close()
  globalEkkoAgents.clear()
  globalEkkoSetup?.close()
  globalEkkoSetup = undefined
  globalEkkoSetupOptions = undefined
}
