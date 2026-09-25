import { randomUUID } from 'node:crypto'
import { chmodSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { EkkoDatabaseManager, EkkoDatabaseMigrationError } from './database'
import {
  EkkoDirectoryManager,
  type EkkoDirectoryInitializationOptions,
  type EkkoDirectoryLayout,
} from './directories'
import { MemoryService } from './memory/service'
import { EkkoJevClient, resolveEkkoJevConfig, type EkkoJevOverrides } from './jev'
import { resolveEkkoDataDirectory } from './memory/paths'
import { SqliteMemoryStore } from './memory/store'
import { EkkoToolApprovalService } from './tools/approval'
import {
  EkkoConfigError,
  EkkoConfigStore,
  type ConfiguredModelAuthorizationEntry,
  type ConfiguredModelProviderEntry,
  type InstallModelProviderPresetOptions,
} from './config-store'
import { EkkoConversationStore } from './conversations/store'
import {
  createConfiguredModelClient,
  modelRequestDefaultsFromConfig,
  resolveConfiguredModelProvider,
  type ResolveConfiguredModelProviderInput,
} from './model/provider-config'
import type { ModelClient, ModelClientOptions, ModelProviderConfig } from './model/types'
import {
  EkkoModelAuthorizationManager,
  type EkkoModelAuthorizationCredentials,
  type EkkoModelAuthorizationRefresher,
} from './model/authorization'
import { AuthorizedModelClient } from './model/authorized-client'
import { EkkoModelManager } from './model/manager'
import type { EkkoModelProviderPreset } from './model/provider-presets'
import { AgentRuntime } from './runtime/runtime'
import { EkkoRuntimeManager } from './runtime/manager'
import type { AgentRuntimeOptions } from './runtime/types'
import { createDefaultToolRegistry } from './tools/registry'
import { EkkoToolManager } from './tools/manager'
import { EkkoSkillManager } from './skills/manager'
import { resolveEkkoExternalSkillDirectories } from './skills/external-directories'
import { EkkoFileLogger } from './logging/file-logger'
import type {
  EkkoConfig,
  EkkoConfigPatch,
  EkkoModelAuthorizationSettings,
  EkkoModelProviderSettings,
} from './config'
import { EkkoAgentManager } from './agent/manager'
import { EkkoProfileAgent } from './agent/profile-agent'
import { EkkoDiagnosticsRegistry, profileScope } from './diagnostics'
import {
  EKKO_RECOVERABLE_DATABASE_TABLES,
  EkkoRecoveryService,
} from './recovery'

export interface SetupEkkoAgentOptions extends EkkoDirectoryInitializationOptions {
  baseDirectory?: string
  profiles?: string[]
  /**
   * Installation-wide config patch applied to the canonical config before
   * Profile agents and runtime services are created.
   */
  config?: EkkoConfigPatch
  /** In-memory JEV overrides, applied after persisted config.jev; never written back. */
  jev?: EkkoJevOverrides
  env?: Record<string, string | undefined>
  packageRoot?: string
  authorizationRefresher?: EkkoModelAuthorizationRefresher
  authorizationFetch?: ModelClientOptions['fetch']
  authorizationNow?: () => number
}

export interface EkkoProfileDirectoryLayout {
  profile: string
  skillDirectory: string
  logDirectory: string
  workspaceDirectory: string
}

export interface CreateEkkoRuntimeOptions extends Omit<AgentRuntimeOptions, 'memory'> {
  profile?: string
  provider?: string
  model?: string
  apiKey?: string
  clientOptions?: ModelClientOptions
  /** Disable the shared memory service for this runtime without changing global config. */
  memory?: AgentRuntimeOptions['memory'] | false
}

function ensureStartupConfig(config: EkkoConfigStore): EkkoConfig {
  try {
    return config.ensureDefaults()
  } catch (error) {
    if (!(error instanceof EkkoConfigError)) throw error

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = join(
      dirname(config.configPath),
      `config.invalid-${timestamp}-${randomUUID()}.json`,
    )
    copyFileSync(config.configPath, backupPath)
    try {
      chmodSync(backupPath, 0o600)
    } catch {
      // Some filesystems do not expose POSIX permissions.
    }

    const recovered = config.reset()
    console.warn(
      `[ekko-agent] invalid config was backed up to ${backupPath}; defaults restored: ${error.message}`,
    )
    return recovered
  }
}

/**
 * Process-level Ekko resources created before any agent run.
 *
 * The setup owns its database connection and memory service. Profile agents
 * borrow these resources and must not close them independently.
 */
export class EkkoAgentSetup {
  readonly directories: EkkoDirectoryManager
  readonly layout: EkkoDirectoryLayout
  readonly diagnostics: EkkoDiagnosticsRegistry
  readonly recovery: EkkoRecoveryService
  readonly config: EkkoConfigStore
  readonly jev: EkkoJevClient
  readonly database: EkkoDatabaseManager
  readonly memoryStore: SqliteMemoryStore
  readonly memory: MemoryService
  readonly conversations: EkkoConversationStore
  readonly conversation: EkkoConversationStore
  readonly authorizations: EkkoModelAuthorizationManager
  readonly authorization: EkkoModelAuthorizationManager
  readonly model: EkkoModelManager
  readonly tool: EkkoToolManager
  readonly skill: EkkoSkillManager
  readonly runtime: EkkoRuntimeManager
  readonly agent: EkkoAgentManager
  readonly agents: EkkoAgentManager
  readonly default: EkkoProfileAgent
  private readonly profileLayouts = new Map<string, EkkoProfileDirectoryLayout>()
  private readonly directProfileProperties = new Set<string>()
  private currentToolApprovals: EkkoToolApprovalService
  private readonly unsubscribeConfig: () => void
  private readonly jevOverrides?: EkkoJevOverrides
  private closed = false

  constructor(options: SetupEkkoAgentOptions = {}) {
    this.jevOverrides = options.jev === undefined ? undefined : structuredClone(options.jev)
    const dataDirectory = resolveEkkoDataDirectory({
      baseDirectory: options.baseDirectory,
      env: options.env,
      packageRoot: options.packageRoot,
    })
    this.diagnostics = new EkkoDiagnosticsRegistry()
    this.directories = new EkkoDirectoryManager(dirname(dataDirectory))
    let startupSkillError: unknown
    this.layout = this.directories.initialize({
      hermesRootDirectory: options.hermesRootDirectory,
      onSkillError: error => {
        startupSkillError = error
        try {
          options.onSkillError?.(error)
        } catch (callbackError) {
          console.warn(
            `[ekko-agent] onSkillError callback failed: ` +
            `${callbackError instanceof Error ? callbackError.message : String(callbackError)}`,
          )
        }
      },
    })
    this.recovery = new EkkoRecoveryService({
      diagnostics: this.diagnostics,
      directories: this.directories,
      databasePath: this.layout.databasePath,
      env: options.env,
    })
    if (startupSkillError) {
      this.recovery.recordSkillsFailure(undefined, 'startup.initialize_skills', startupSkillError)
    }
    this.config = new EkkoConfigStore({ configPath: this.layout.configPath })
    const startupConfig = ensureStartupConfig(this.config)
    const config = options.config
      ? this.config.update(options.config)
      : startupConfig
    this.jev = new EkkoJevClient(resolveEkkoJevConfig(config.jev, this.jevOverrides))
    this.authorizations = new EkkoModelAuthorizationManager({
      config: this.config,
      refresher: options.authorizationRefresher,
      fetch: options.authorizationFetch,
      now: options.authorizationNow,
    })
    this.currentToolApprovals = this.createToolApprovals(config)
    this.authorization = this.authorizations
    this.tool = new EkkoToolManager({
      createRegistry: profile => this.createProfileToolRegistry(profile),
    })
    this.unsubscribeConfig = this.config.onDidChange(nextConfig => {
      this.jev.configure(resolveEkkoJevConfig(nextConfig.jev, this.jevOverrides))
      this.currentToolApprovals = this.createToolApprovals(nextConfig)
      this.tool.invalidate()
      this.memory?.configure({
        enabled: nextConfig.memory.enabled,
        recentMessageLimit: nextConfig.memory.recentMessageLimit,
        automaticRecallTokenBudget: nextConfig.memory.automaticRecallTokenBudget,
        searchResultLimit: nextConfig.memory.searchResultLimit,
      })
    })
    this.skill = new EkkoSkillManager(this.tool)
    this.model = new EkkoModelManager({
      config: this.config,
      authorizations: this.authorizations,
      resolveProvider: input => this.modelProviderConfig(input),
      createClient: (input, clientOptions) => this.createModelClient(input, clientOptions),
    })
    this.runtime = new EkkoRuntimeManager({
      create: runtimeOptions => this.createRuntime(runtimeOptions),
    })
    let database = new EkkoDatabaseManager({
      databasePath: this.layout.databasePath,
      env: options.env,
    })
    let memoryStore: SqliteMemoryStore
    let conversations: EkkoConversationStore
    try {
      try {
        memoryStore = new SqliteMemoryStore(database)
        conversations = new EkkoConversationStore(database)
      } catch (error) {
        database.close()
        if (!(error instanceof EkkoDatabaseMigrationError) || error.lockFailure) throw error

        const backupPath = database.quarantineForRebuild()
        database = new EkkoDatabaseManager({
          databasePath: this.layout.databasePath,
          env: options.env,
        })
        try {
          memoryStore = new SqliteMemoryStore(database)
          conversations = new EkkoConversationStore(database)
        } catch (rebuildError) {
          database.restoreQuarantinedDatabase(backupPath)
          throw new Error(
            `Ekko database rebuild failed; the original database was restored from ${backupPath}.`,
            { cause: rebuildError },
          )
        }

        try {
          const recovery = database.recoverCompatibleTables(
            backupPath,
            EKKO_RECOVERABLE_DATABASE_TABLES,
          )
          memoryStore.rebuildSearchIndex()
          console.warn(
            `[ekko-agent] database rebuilt after migration failure; backup=${backupPath}; ` +
            `recovered=${JSON.stringify(recovery.recoveredTables)}; skipped=${JSON.stringify(recovery.skippedTables)}`,
          )
        } catch (recoveryError) {
          console.warn(
            `[ekko-agent] database rebuilt but data recovery could not read the backup at ${backupPath}: ` +
            `${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
          )
        }
      }
    } catch (error) {
      database.close()
      this.recovery.recordDatabaseFailure('startup.initialize_persistent_database', error)
      console.warn(
        `[ekko-agent] persistent database unavailable; Core is continuing with ephemeral storage: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      )
      database = new EkkoDatabaseManager({ databasePath: ':memory:', env: options.env })
      memoryStore = new SqliteMemoryStore(database)
      conversations = new EkkoConversationStore(database)
    }

    this.database = database
    this.memoryStore = memoryStore
    this.recovery.configureMemorySelfCheck(() => {
      memoryStore.databaseManager.connection.prepare('SELECT 1 FROM memory_nodes LIMIT 1').get()
      return { ok: true, detail: `Active memory store is readable (${database.databasePath}).` }
    })
    this.memory = this.createMemoryService(config, memoryStore)
    this.conversations = conversations
    this.conversation = conversations

    this.agent = new EkkoAgentManager({
      create: profile => this.createProfileAgent(profile),
      onCreate: profileAgent => this.attachProfileAgent(profileAgent),
      onRemove: profileAgent => this.detachProfileAgent(profileAgent),
    })
    this.agents = this.agent

    const profiles = new Set([
      'default',
      ...this.directories.profileNames(),
      ...(options.profiles ?? []),
    ])
    try {
      for (const profile of profiles) this.agent.ensure(profile)
      this.default = this.agent.get('default')
    } catch (error) {
      this.close()
      throw error
    }
  }

  ensureProfile(profile = 'default'): EkkoProfileDirectoryLayout {
    const layout = this.ensureProfileLayout(profile)
    this.agent.ensure(layout.profile)
    return layout
  }

  private ensureProfileLayout(profile = 'default'): EkkoProfileDirectoryLayout {
    const normalizedProfile = String(profile || '').trim() || 'default'
    const existing = this.profileLayouts.get(normalizedProfile)
    if (existing) return existing
    const skillDirectory = this.directories.profileSkillsPath(normalizedProfile)
    try {
      this.directories.synchronizeProfileSkills(normalizedProfile)
      const selfCheck = this.recovery.selfCheckAndResolve('skills', normalizedProfile)
      if (!selfCheck.ok) {
        this.recovery.recordSkillsFailure(
          normalizedProfile,
          'profile.validate_bundled_skills',
          new Error(selfCheck.checks.filter(check => !check.ok).map(check => check.detail).join('; ')),
        )
      }
    } catch (error) {
      this.recovery.recordSkillsFailure(normalizedProfile, 'profile.sync_bundled_skills', error)
    }
    let logDirectory = this.directories.profileLogsPath(normalizedProfile)
    try {
      logDirectory = this.directories.profileLogsDirectory(normalizedProfile)
      const selfCheck = this.recovery.selfCheckAndResolve('logs', normalizedProfile)
      if (!selfCheck.ok) {
        this.recovery.recordLogsFailure(
          normalizedProfile,
          'profile.validate_log_directory',
          new Error(selfCheck.checks.filter(check => !check.ok).map(check => check.detail).join('; ')),
        )
      }
    } catch (error) {
      this.recovery.recordLogsFailure(normalizedProfile, 'profile.initialize_log_directory', error)
    }
    const layout = {
      profile: normalizedProfile,
      skillDirectory,
      logDirectory,
      workspaceDirectory: this.directories.profileWorkspaceDirectory(normalizedProfile),
    }
    this.profileLayouts.set(normalizedProfile, layout)
    return layout
  }

  profile(profile = 'default'): EkkoProfileDirectoryLayout {
    const normalizedProfile = String(profile || '').trim() || 'default'
    const layout = this.profileLayouts.get(normalizedProfile)
    if (!layout) {
      throw new Error(`Ekko profile is not set up: ${normalizedProfile}`)
    }
    return layout
  }

  profiles(): EkkoProfileDirectoryLayout[] {
    return this.agent.list().map(profileAgent => profileAgent.layout)
  }

  getAgent(profile = 'default'): EkkoProfileAgent {
    return this.agent.get(profile)
  }

  get toolApprovals(): EkkoToolApprovalService {
    return this.currentToolApprovals
  }

  modelProviderConfig(
    input: Omit<ResolveConfiguredModelProviderInput, 'config'> = {},
  ): ModelProviderConfig {
    return resolveConfiguredModelProvider({
      ...input,
      config: this.config.read(),
    })
  }

  createModelClient(
    input: Omit<ResolveConfiguredModelProviderInput, 'config'> = {},
    clientOptions: ModelClientOptions = {},
  ): ModelClient {
    const config = this.config.read()
    const provider = String(input.provider || config.model.defaultProvider || '').trim()
    const providerSettings = config.model.providers[provider]
    if (
      provider &&
      input.apiKey === undefined &&
      (providerSettings?.authType === 'oauth' || !!config.model.authorizations[provider])
    ) {
      return new AuthorizedModelClient({
        config: this.config,
        authorizations: this.authorizations,
        provider,
        model: input.model,
        clientOptions,
      })
    }
    return createConfiguredModelClient({
      ...input,
      config,
      clientOptions,
    })
  }

  createRuntime(options: CreateEkkoRuntimeOptions = {}): AgentRuntime {
    const {
      profile = 'default',
      provider,
      model,
      apiKey,
      clientOptions,
      memory,
      ...runtimeOverrides
    } = options
    const config = this.config.read()
    const profileLayout = this.ensureProfile(profile)
    const toolsEnabled = runtimeOverrides.toolsEnabled ?? config.tools.enabled
    const skillsEnabled = runtimeOverrides.skillsEnabled ?? config.skills.enabled
    const skillDirectory = runtimeOverrides.skillDirectory ?? profileLayout.skillDirectory
    const profileSkillConfig = config.skills.profiles[profileLayout.profile] ?? {
      disabled: [],
      externalDirectories: [],
    }
    const usesProfileSkillDirectory = skillDirectory === profileLayout.skillDirectory
    const externalSkillDirectories = runtimeOverrides.externalSkillDirectories
      ?? (usesProfileSkillDirectory
        ? resolveEkkoExternalSkillDirectories(profileSkillConfig.externalDirectories, {
            localSkillDirectory: profileLayout.skillDirectory,
          })
        : [])
    const disabledSkillNames = runtimeOverrides.disabledSkillNames
      ?? (usesProfileSkillDirectory ? profileSkillConfig.disabled : [])
    const toolAuthorizer = runtimeOverrides.toolAuthorizer ?? this.toolApprovals.authorize
    const selectedProvider = String(provider || config.model.defaultProvider || '').trim()
    const modelClient = runtimeOverrides.modelClient ?? (selectedProvider
      ? this.createModelClient({ provider: selectedProvider, model, apiKey }, clientOptions)
      : undefined)
    const tools = runtimeOverrides.tools ?? (toolsEnabled
      ? this.tool.createRuntimeRegistry(
          profile,
          usesProfileSkillDirectory
            ? undefined
            : this.createProfileToolRegistry(
                profile,
                skillDirectory,
                externalSkillDirectories,
                disabledSkillNames,
              ),
        )
      : undefined)
    const modelDefaults = {
      ...modelRequestDefaultsFromConfig(config, provider),
      ...runtimeOverrides.modelDefaults,
      ...(model ? { model } : {}),
    }
    const configuredMcpServers = config.mcp.enabled
      ? config.mcp.profiles[profileLayout.profile]?.servers ?? {}
      : {}
    const toolContext = runtimeOverrides.toolContext?.mcpServers === undefined
      ? { ...runtimeOverrides.toolContext, mcpServers: configuredMcpServers }
      : runtimeOverrides.toolContext

    return new AgentRuntime({
      ...runtimeOverrides,
      jev: resolveEkkoJevConfig(config.jev, this.jevOverrides, runtimeOverrides.jev),
      profileId: profile,
      modelClient,
      toolsEnabled,
      tools,
      toolAuthorizer,
      toolContext,
      skillsEnabled,
      skillsAvailable: runtimeOverrides.skillsAvailable ?? (() => (
        !this.diagnostics.get('skills', 'global') &&
        !this.diagnostics.get('skills', profileScope(profileLayout.profile))
      )),
      skills: runtimeOverrides.skills ?? this.skill.runtimeSkills(profile),
      skillDirectory,
      externalSkillDirectories,
      disabledSkillNames,
      skillReviewEveryToolCalls: runtimeOverrides.skillReviewEveryToolCalls
        ?? config.skills.reviewEveryToolCalls,
      runtimeInstructions: runtimeOverrides.runtimeInstructions ?? config.prompt.instructions,
      temporaryRuntimeInstructions: () => [
        ...(runtimeOverrides.temporaryRuntimeInstructions?.() ?? []),
        this.recovery.temporaryContext(profileLayout.profile) ?? '',
      ].filter(Boolean),
      recoveryDirective: runtimeOverrides.recoveryDirective ?? (() => (
        this.recovery.runtimeDirective(profileLayout.profile)
      )),
      maxSteps: runtimeOverrides.maxSteps ?? config.runtime.maxSteps,
      maxModelRetries: runtimeOverrides.maxModelRetries ?? config.runtime.maxModelRetries,
      toolFailureRecoveryThreshold: runtimeOverrides.toolFailureRecoveryThreshold
        ?? runtimeOverrides.maxConsecutiveToolFailures
        ?? config.runtime.toolFailureRecoveryThreshold,
      backgroundDelegationEnabled: runtimeOverrides.backgroundDelegationEnabled
        ?? config.delegation.backgroundEnabled,
      subtaskMaxSteps: runtimeOverrides.subtaskMaxSteps ?? config.delegation.subtaskMaxSteps,
      modelDefaults,
      memory: memory === false
        ? undefined
        : memory ?? (config.memory.enabled ? this.memory : undefined),
      logWriter: runtimeOverrides.logWriter ?? new EkkoFileLogger({
        directory: profileLayout.logDirectory,
        maxBytes: config.logging.maxBytes,
        onError: error => this.recovery.recordLogsFailure(
          profileLayout.profile,
          'runtime.write_log',
          error,
        ),
      }),
      logProfile: runtimeOverrides.logProfile ?? profile,
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.unsubscribeConfig()
    this.memory.close()
  }

  private createToolApprovals(config: EkkoConfig): EkkoToolApprovalService {
    return new EkkoToolApprovalService({
      configPath: this.layout.configPath,
      enabled: config.tools.approvals.enabled,
      timeoutMs: config.tools.approvals.timeoutMs,
    })
  }

  private createProfileAgent(profile: string): EkkoProfileAgent {
    this.config.ensureDefaults()
    const profileLayout = this.ensureProfileLayout(profile)
    return new EkkoProfileAgent({
      profile: profileLayout.profile,
      layout: profileLayout,
      directories: this.directories,
      rootDirectory: this.layout.rootDirectory,
      skillsDirectory: this.layout.skillsDirectory,
      logsDirectory: this.layout.logsDirectory,
      workspaceDirectory: this.layout.workspaceDirectory,
      config: this.config,
      database: this.database,
      memoryStore: this.memoryStore,
      memory: this.memory,
      conversations: this.conversations,
      authorization: this.authorizations,
      model: this.model,
      tools: this.tool,
      skills: this.skill,
      toolApprovals: () => this.toolApprovals,
      createRuntime: options => this.createRuntime(options),
      onLogError: error => this.recovery.recordLogsFailure(
        profileLayout.profile,
        'profile.write_log',
        error,
      ),
    })
  }

  private attachProfileAgent(profileAgent: EkkoProfileAgent): void {
    const profile = profileAgent.profile
    if (profile === 'default' || profile in this) return
    Object.defineProperty(this, profile, {
      configurable: true,
      enumerable: true,
      get: () => this.agent.find(profile),
    })
    this.directProfileProperties.add(profile)
  }

  private detachProfileAgent(profileAgent: EkkoProfileAgent): void {
    if (!this.directProfileProperties.delete(profileAgent.profile)) return
    delete (this as Record<string, unknown>)[profileAgent.profile]
  }

  private createProfileToolRegistry(
    profile: string,
    skillDirectory?: string,
    externalSkillDirectories = resolveEkkoExternalSkillDirectories(
      this.config.getSkillProfile(profile).externalDirectories,
      { localSkillDirectory: this.ensureProfile(profile).skillDirectory },
    ),
    disabledSkillNames = this.config.getSkillProfile(profile).disabled,
  ) {
    const config = this.config.read()
    const profileLayout = this.ensureProfile(profile)
    return createDefaultToolRegistry({
      skillDirectory: skillDirectory ?? profileLayout.skillDirectory,
      externalSkillDirectories,
      disabledSkillNames,
      authorizer: (name, input, context) => this.toolApprovals.authorize(name, input, context),
      executionTimeoutMs: config.tools.executionTimeoutMs,
      codeExec: {
        enabled: config.tools.codeExec.enabled,
        allowedLanguages: config.tools.codeExec.languages,
        timeoutMs: config.tools.codeExec.timeoutMs,
        maxToolCalls: config.tools.codeExec.maxToolCalls,
        maxOutputBytes: config.tools.codeExec.maxOutputBytes,
        maxStderrBytes: config.tools.codeExec.maxStderrBytes,
        maxSourceBytes: config.tools.codeExec.maxSourceBytes,
      },
      recovery: this.recovery,
    })
  }

  private createMemoryService(config: EkkoConfig, store = this.memoryStore): MemoryService {
    const ephemeral = this.database.databasePath === ':memory:'
    return new MemoryService({
      store,
      enabled: config.memory.enabled,
      storageMode: ephemeral ? 'ephemeral' : 'persistent',
      ...(ephemeral ? {
        warning: 'Persistent Ekko memory is unavailable; the active store is ephemeral and cannot establish whether durable memories exist.',
      } : {}),
      recentMessageLimit: config.memory.recentMessageLimit,
      automaticRecallTokenBudget: config.memory.automaticRecallTokenBudget,
      searchResultLimit: config.memory.searchResultLimit,
      onWarning: error => this.recovery.recordMemoryFailure('runtime.memory_operation', error),
    })
  }
}

/**
 * Public all-in-one facade. Namespaced stores remain available for callers
 * that prefer `agent.config`, `agent.authorizations`, or `agent.memory`.
 */
export class EkkoAgent extends EkkoAgentSetup {
  readConfig(): EkkoConfig {
    return this.config.read()
  }

  updateConfig(patch: EkkoConfigPatch): EkkoConfig {
    return this.config.update(patch)
  }

  replaceConfig(config: EkkoConfig): EkkoConfig {
    return this.config.replace(config)
  }

  resetConfig(): EkkoConfig {
    return this.config.reset()
  }

  listModelProviderPresets(): EkkoModelProviderPreset[] {
    return this.config.listModelProviderPresets()
  }

  getModelProviderPreset(id: string): EkkoModelProviderPreset | undefined {
    return this.config.getModelProviderPreset(id)
  }

  setModelProviderPreset(
    id: string,
    preset: Omit<EkkoModelProviderPreset, 'id'> & { id?: string },
  ): EkkoConfig {
    return this.config.setModelProviderPreset(id, preset)
  }

  updateModelProviderPreset(id: string, patch: Partial<EkkoModelProviderPreset>): EkkoConfig {
    return this.config.updateModelProviderPreset(id, patch)
  }

  deleteModelProviderPreset(id: string): boolean {
    return this.config.deleteModelProviderPreset(id)
  }

  installModelProviderPreset(
    id: string,
    options: InstallModelProviderPresetOptions = {},
  ): EkkoConfig {
    return this.config.installModelProviderPreset(id, options)
  }

  listModelProviders(): ConfiguredModelProviderEntry[] {
    return this.config.listModelProviders()
  }

  getModelProvider(id: string): EkkoModelProviderSettings | undefined {
    return this.config.getModelProvider(id)
  }

  setModelProvider(id: string, settings: EkkoModelProviderSettings): EkkoConfig {
    return this.config.setModelProvider(id, settings)
  }

  updateModelProvider(id: string, patch: Partial<EkkoModelProviderSettings>): EkkoConfig {
    return this.config.updateModelProvider(id, patch)
  }

  deleteModelProvider(id: string): boolean {
    return this.config.deleteModelProvider(id)
  }

  setDefaultModel(provider: string, model?: string): EkkoConfig {
    return this.config.setDefaultModel(provider, model)
  }

  listModelAuthorizations(): ConfiguredModelAuthorizationEntry[] {
    return this.config.listModelAuthorizations()
  }

  getModelAuthorization(provider: string): EkkoModelAuthorizationSettings | undefined {
    return this.authorizations.get(provider)
  }

  setModelAuthorization(provider: string, settings: EkkoModelAuthorizationSettings): EkkoConfig {
    return this.authorizations.set(provider, settings)
  }

  updateModelAuthorization(
    provider: string,
    patch: Partial<EkkoModelAuthorizationSettings>,
  ): EkkoConfig {
    return this.authorizations.update(provider, patch)
  }

  deleteModelAuthorization(provider: string): boolean {
    return this.authorizations.delete(provider)
  }

  modelAuthorizationNeedsRefresh(provider: string): boolean {
    return this.authorizations.needsRefresh(provider)
  }

  refreshModelAuthorization(
    provider: string,
    model?: string,
  ): Promise<EkkoModelAuthorizationCredentials> {
    return this.authorizations.refresh(provider, model)
  }

  resolveModelAuthorization(
    provider: string,
    model?: string,
  ): Promise<EkkoModelAuthorizationCredentials> {
    return this.authorizations.resolve(provider, model)
  }
}

export function setupEkkoAgent(options: SetupEkkoAgentOptions = {}): EkkoAgent {
  return new EkkoAgent(options)
}
