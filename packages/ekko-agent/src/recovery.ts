import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { EkkoDirectoryManager } from './directories'
import {
  EkkoDiagnosticsRegistry,
  profileScope,
  type EkkoDiagnosticIncident,
  type EkkoDiagnosticsSnapshot,
  type EkkoSelfCheckResult,
} from './diagnostics'
import { EkkoConversationStore } from './conversations/store'
import { EkkoDatabaseManager } from './database'
import { SqliteMemoryStore } from './memory/store'
import type { AgentRuntimeRecoveryDirective } from './runtime/types'

export const EKKO_RECOVERABLE_DATABASE_TABLES = [
  'memory_messages',
  'memory_nodes',
  'memory_audit_events',
  'memory_embeddings',
  'sessions',
  'messages',
] as const

export const EKKO_DATABASE_SCHEMA_BLUEPRINT = {
  owner: 'ekko-agent compiled migrations (memory@8, conversations@1)',
  rule: 'Create or upgrade the database only by running Ekko migrations; never hand-write repair SQL.',
  tables: {
    schema_migrations: ['component', 'version', 'applied_at'],
    memory_messages: ['row_id', 'id', 'session_id', 'parent_id', 'role', 'content', 'metadata_json', 'created_at'],
    memory_nodes: [
      'row_id', 'id', 'parent_id', 'supersedes_id', 'profile_id', 'scope_type',
      'scope_namespace', 'scope_id', 'origin_json', 'domain', 'category_path_json',
      'category_path_text', 'type', 'key', 'revision', 'value_json', 'title',
      'content', 'status', 'confidence', 'importance', 'tags_json', 'entities_json',
      'source_message_ids_json', 'created_at', 'updated_at', 'expires_at',
    ],
    memory_audit_events: [
      'row_id', 'id', 'event_type', 'node_id', 'session_id', 'profile_id',
      'actor', 'reason', 'payload_json', 'created_at',
    ],
    memory_embeddings: ['node_id', 'model', 'embedding', 'created_at'],
    sessions: [
      'id', 'profile', 'source', 'agent', 'agent_mode', 'agent_session_id',
      'agent_native_session_id', 'user_id', 'model', 'provider', 'api_mode', 'title',
      'parent_session_id', 'fork_point_message_id', 'started_at', 'ended_at',
      'end_reason', 'message_count', 'tool_call_count', 'input_tokens', 'output_tokens',
      'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'billing_provider',
      'estimated_cost_usd', 'actual_cost_usd', 'cost_status', 'preview', 'last_active',
      'is_archived', 'workspace', 'category_id', 'history_revision',
    ],
    messages: [
      'id', 'session_id', 'role', 'content', 'display_role', 'display_content',
      'tool_call_id', 'tool_calls', 'tool_name', 'timestamp', 'token_count',
      'finish_reason', 'reasoning', 'reasoning_details', 'reasoning_content',
    ],
  },
} as const

export type EkkoDatabaseRecoveryStrategy = 'retry' | 'rebuild'
export type EkkoSelfCheckComponent = 'all' | 'skills' | 'database' | 'memory' | 'logs'

export interface EkkoRecoveryServiceOptions {
  diagnostics: EkkoDiagnosticsRegistry
  directories: EkkoDirectoryManager
  databasePath: string
  env?: Record<string, string | undefined>
}

export interface EkkoRecoverySnapshot extends EkkoDiagnosticsSnapshot {
  capabilities: {
    skills: { sourceDirectory?: string; rootDirectory: string }
    database: {
      targetPath: string
      activeStorage: 'persistent' | 'ephemeral'
      targetReady: boolean
      restartRequired: boolean
      schemaOwner: string
    }
  }
}

/**
 * Deterministic host recovery. The model can select an exposed operation, but
 * paths, copy semantics, migrations, and validation remain code-owned.
 */
export class EkkoRecoveryService {
  private activeStorage: 'persistent' | 'ephemeral' = 'persistent'
  private targetReady = true
  private memorySelfCheck?: () => { ok: boolean; detail: string }

  constructor(private readonly options: EkkoRecoveryServiceOptions) {}

  recordSkillsFailure(profile: string | undefined, operation: string, error: unknown): EkkoDiagnosticIncident {
    const source = this.options.directories.bundledSkillsSourceDirectory()
    const target = profile
      ? this.options.directories.profileSkillsPath(profile)
      : this.options.directories.skillsDirectory
    return this.options.diagnostics.report({
      component: 'skills',
      scope: profile ? profileScope(profile) : 'global',
      operation,
      error,
      effect: 'Skill discovery and reusable Skill instructions are unavailable; Core dialogue and packaged built-in tools remain available.',
      recovery: {
        tool: 'ekko_repair_skills',
        summary: 'Retry the code-owned bundled Skill synchronizer, then verify every bundled SKILL.md is readable.',
        steps: [
          'Inspect the exact source and target paths with ekko_diagnostics.',
          'Release the Windows file handle or repair ACLs if EPERM/EACCES persists.',
          'Call ekko_repair_skills; it preserves user-modified name conflicts.',
          'Accept recovery only when the built-in self-check passes.',
        ],
        automatic: true,
        ...(source ? { source } : {}),
        target,
      },
    })
  }

  recordDatabaseFailure(operation: string, error: unknown): EkkoDiagnosticIncident {
    this.activeStorage = 'ephemeral'
    this.targetReady = false
    return this.options.diagnostics.report({
      component: 'database',
      operation,
      error,
      effect: 'Persistent Ekko memory and conversation storage are unavailable; this process uses an ephemeral SQLite fallback so Core dialogue can continue.',
      recovery: {
        tool: 'ekko_repair_database',
        summary: 'Retry the persistent database with compiled migrations, or explicitly confirm a quarantine-and-rebuild if retry cannot recover it.',
        steps: [
          'Call ekko_database_schema for the code-owned schema and required fields.',
          'Use strategy=retry first; it does not delete or quarantine the database.',
          'If retry fails, inspect the exact target type and parent permissions with terminal_exec. Repair obvious blockers only inside the Ekko-owned target path, then retry.',
          'Safe retry and repair of an obvious Ekko-owned path blocker do not require asking the user. Never claim persistent memory is empty while ephemeral storage is active.',
          'Use strategy=rebuild only with confirmed=true; the original database family is preserved as a backup.',
          'The repair tool runs ekko_self_check logic internally. After it succeeds, the host must reload Ekko Setup at a completed-run boundary; Ekko Studio does this automatically.',
        ],
        automatic: false,
        requiresConfirmation: true,
        target: this.options.databasePath,
        schemaOwner: EKKO_DATABASE_SCHEMA_BLUEPRINT.owner,
        schema: databaseSchemaFields(),
      },
      metadata: {
        activeStorage: 'ephemeral',
        requiredTables: Object.keys(EKKO_DATABASE_SCHEMA_BLUEPRINT.tables),
      },
    })
  }

  recordMemoryFailure(operation: string, error: unknown): EkkoDiagnosticIncident {
    return this.options.diagnostics.report({
      component: 'memory',
      operation,
      error,
      effect: 'Ekko memory recall or writes are degraded; Core dialogue continues without relying on the failed memory operation.',
      recovery: {
        tool: 'ekko_self_check',
        summary: 'Inspect the active store, correct its underlying database/filesystem condition, then run the memory self-check.',
        steps: [
          'Use ekko_diagnostics to inspect the exact memory error.',
          'If the persistent database is also degraded, repair that incident first.',
          'Call ekko_self_check with component=memory; only a passing active-store probe clears this incident.',
        ],
        automatic: false,
        target: this.activeStorage === 'persistent' ? this.options.databasePath : ':memory:',
        schemaOwner: EKKO_DATABASE_SCHEMA_BLUEPRINT.owner,
        schema: databaseSchemaFields(),
      },
      metadata: { activeStorage: this.activeStorage },
    })
  }

  recordLogsFailure(profile: string | undefined, operation: string, error: unknown): EkkoDiagnosticIncident {
    const target = this.options.directories.profileLogsPath(profile)
    return this.options.diagnostics.report({
      component: 'logs',
      scope: profile ? profileScope(profile) : 'global',
      operation,
      error,
      effect: 'Structured Ekko file logging is unavailable; Core dialogue and every other capability continue with logging disabled.',
      recovery: {
        tool: 'ekko_repair_logs',
        summary: 'Recreate the exact Profile log directory, verify it is writable, and resume file logging without restarting Ekko.',
        steps: [
          'Inspect the exact log target with ekko_diagnostics.',
          'Release a file handle or repair permissions/type blockers only inside the Ekko-owned log path.',
          'Call ekko_repair_logs for the affected Profile.',
          'Accept recovery only when the built-in log directory self-check passes.',
        ],
        automatic: true,
        target,
      },
    })
  }

  configureMemorySelfCheck(check: () => { ok: boolean; detail: string }): void {
    this.memorySelfCheck = check
  }

  snapshot(): EkkoRecoverySnapshot {
    const diagnostics = this.options.diagnostics.snapshot()
    return {
      ...diagnostics,
      status: diagnostics.status === 'degraded' || this.activeStorage === 'ephemeral'
        ? 'degraded'
        : 'ok',
      capabilities: {
        skills: {
          ...(this.options.directories.bundledSkillsSourceDirectory()
            ? { sourceDirectory: this.options.directories.bundledSkillsSourceDirectory() }
            : {}),
          rootDirectory: this.options.directories.skillsDirectory,
        },
        database: {
          targetPath: this.options.databasePath,
          activeStorage: this.activeStorage,
          targetReady: this.targetReady,
          restartRequired: this.activeStorage === 'ephemeral' && this.targetReady,
          schemaOwner: EKKO_DATABASE_SCHEMA_BLUEPRINT.owner,
        },
      },
    }
  }

  temporaryContext(profile = 'default'): string | undefined {
    const incidentContext = this.options.diagnostics.temporaryContext(profile)
    const restartContext = this.activeStorage === 'ephemeral' && this.targetReady
      ? [
          'Ekko persistent database now passes self-check, but this running setup still uses ephemeral storage.',
          'Ekko Studio will automatically reload Ekko Setup after all active runs finish; the next run will use persistent storage.',
          'A standalone host must recreate its Ekko Setup at the same completed-run boundary.',
        ].join('\n')
      : undefined
    return [incidentContext, restartContext].filter(Boolean).join('\n') || undefined
  }

  runtimeDirective(profile = 'default'): AgentRuntimeRecoveryDirective {
    const scope = profileScope(profile)
    const incidents = this.options.diagnostics.snapshot().active
      .filter(incident => incident.scope === 'global' || incident.scope === scope)
    const automaticToolCalls = [...new Map(incidents.map(incident => {
      const call = incident.component === 'database'
        ? { name: 'ekko_repair_database', arguments: { strategy: 'retry' } }
        : incident.component === 'skills'
          ? { name: 'ekko_repair_skills', arguments: { profile } }
          : incident.component === 'logs'
            ? { name: 'ekko_repair_logs', arguments: { profile } }
            : { name: 'ekko_self_check', arguments: { component: 'memory', profile } }
      return [call.name, call] as const
    })).values()]
    return {
      active: incidents.length > 0,
      automaticToolCalls,
      allowedToolNames: [
        'ekko_diagnostics',
        'ekko_database_schema',
        'ekko_repair_skills',
        'ekko_repair_logs',
        'ekko_repair_database',
        'ekko_self_check',
        'terminal_exec',
        'read_file',
        'write_file',
      ],
      reminder: [
        'Ekko runtime recovery guard: active capability incidents remain unresolved.',
        'Continue diagnosis and repair now with the available recovery and filesystem tools.',
        'Safe database retry and Profile Skill synchronization are automatic maintenance; do not ask the user for permission.',
        'Only a database rebuild may wait for its existing explicit approval flow.',
        'Do not answer memory availability or claim that memory is empty while persistent storage is unavailable.',
      ].join('\n'),
    }
  }

  databaseSchema() {
    return structuredClone(EKKO_DATABASE_SCHEMA_BLUEPRINT)
  }

  selfCheck(component: EkkoSelfCheckComponent, profile = 'default'): EkkoSelfCheckResult {
    const checks = component === 'all'
      ? [
          ...this.checkSkills(profile).checks,
          ...this.checkDatabase().checks,
          ...this.checkMemory().checks,
          ...this.checkLogs(profile).checks,
        ]
      : component === 'skills'
        ? this.checkSkills(profile).checks
        : component === 'database'
          ? this.checkDatabase().checks
          : component === 'memory'
            ? this.checkMemory().checks
            : this.checkLogs(profile).checks
    return {
      ok: checks.every(check => check.ok),
      component,
      checkedAt: new Date().toISOString(),
      checks,
      metadata: component === 'database' || component === 'all'
        ? { activeStorage: this.activeStorage, targetPath: this.options.databasePath }
        : { profile },
    }
  }

  selfCheckAndResolve(
    component: EkkoSelfCheckComponent,
    profile = 'default',
  ): EkkoSelfCheckResult {
    const skillsResult = component === 'all' || component === 'skills'
      ? this.selfCheck('skills', profile)
      : undefined
    const databaseResult = component === 'all' || component === 'database'
      ? this.selfCheck('database', profile)
      : undefined
    const memoryResult = component === 'all' || component === 'memory'
      ? this.selfCheck('memory', profile)
      : undefined
    const logsResult = component === 'all' || component === 'logs'
      ? this.selfCheck('logs', profile)
      : undefined
    if (skillsResult?.ok) {
      for (const scope of [profileScope(profile), 'global'] as const) {
        const incident = this.options.diagnostics.get('skills', scope)
        if (incident) {
          this.options.diagnostics.resolve('skills', scope, skillsResult, incident.incidentId)
        }
      }
    }
    if (databaseResult?.ok) {
      const incident = this.options.diagnostics.get('database', 'global')
      if (incident) {
        this.options.diagnostics.resolve('database', 'global', databaseResult, incident.incidentId)
      }
      this.targetReady = true
    }
    if (memoryResult?.ok) {
      const incident = this.options.diagnostics.get('memory', 'global')
      if (incident) {
        this.options.diagnostics.resolve('memory', 'global', memoryResult, incident.incidentId)
      }
    }
    if (logsResult?.ok) {
      for (const scope of [profileScope(profile), 'global'] as const) {
        const incident = this.options.diagnostics.get('logs', scope)
        if (incident) {
          this.options.diagnostics.resolve('logs', scope, logsResult, incident.incidentId)
        }
      }
    }
    if (component === 'skills') return skillsResult!
    if (component === 'database') return databaseResult!
    if (component === 'memory') return memoryResult!
    if (component === 'logs') return logsResult!
    const checks = [
      ...skillsResult!.checks,
      ...databaseResult!.checks,
      ...memoryResult!.checks,
      ...logsResult!.checks,
    ]
    return {
      ok: skillsResult!.ok && databaseResult!.ok && memoryResult!.ok && logsResult!.ok,
      component: 'all',
      checkedAt: new Date().toISOString(),
      checks,
      metadata: {
        skills: skillsResult!.metadata,
        database: databaseResult!.metadata,
        memory: memoryResult!.metadata,
        logs: logsResult!.metadata,
      },
    }
  }

  repairSkills(profile = 'default'): {
    ok: boolean
    sourceDirectory?: string
    targetDirectory: string
    selfCheck: EkkoSelfCheckResult
  } {
    const scope = profileScope(profile)
    const incidentId = this.options.diagnostics.get('skills', scope)?.incidentId
    let operationError: unknown
    try {
      this.options.directories.synchronizeProfileSkills(profile)
    } catch (error) {
      operationError = error
      this.recordSkillsFailure(profile, 'repair.sync_bundled_skills', error)
    }
    const selfCheck = this.selfCheck('skills', profile)
    if (!operationError && selfCheck.ok) {
      this.options.diagnostics.resolve('skills', scope, selfCheck, incidentId)
      const globalIncident = this.options.diagnostics.get('skills', 'global')
      if (globalIncident) this.options.diagnostics.resolve('skills', 'global', selfCheck, globalIncident.incidentId)
    }
    const check = safeSkillCheck(this.options.directories, profile)
    return {
      ok: !operationError && selfCheck.ok,
      ...(check.sourceDirectory ? { sourceDirectory: check.sourceDirectory } : {}),
      targetDirectory: check.targetDirectory,
      selfCheck,
    }
  }

  repairLogs(profile = 'default'): {
    ok: boolean
    targetDirectory: string
    selfCheck: EkkoSelfCheckResult
    error?: string
  } {
    const scope = profileScope(profile)
    const incidentId = this.options.diagnostics.get('logs', scope)?.incidentId
    let operationError: unknown
    try {
      this.options.directories.profileLogsDirectory(profile)
    } catch (error) {
      operationError = error
      this.recordLogsFailure(profile, 'repair.create_profile_log_directory', error)
    }
    const selfCheck = this.selfCheck('logs', profile)
    if (!operationError && selfCheck.ok) {
      this.options.diagnostics.resolve('logs', scope, selfCheck, incidentId)
      const globalIncident = this.options.diagnostics.get('logs', 'global')
      if (globalIncident) this.options.diagnostics.resolve('logs', 'global', selfCheck, globalIncident.incidentId)
    }
    return {
      ok: !operationError && selfCheck.ok,
      targetDirectory: this.options.directories.profileLogsPath(profile),
      selfCheck,
      ...(operationError ? { error: operationError instanceof Error ? operationError.message : String(operationError) } : {}),
    }
  }

  repairDatabase(
    strategy: EkkoDatabaseRecoveryStrategy,
    confirmed = false,
  ): {
    ok: boolean
    strategy: EkkoDatabaseRecoveryStrategy
    backupPath?: string
    recoveredTables?: Array<{ table: string; rows: number }>
    skippedTables?: Array<{ table: string; reason: string }>
    restartRequired: boolean
    selfCheck: EkkoSelfCheckResult
    error?: string
  } {
    if (this.activeStorage !== 'ephemeral' || this.targetReady) {
      const selfCheck = this.selfCheck('database')
      return {
        ok: false,
        strategy,
        restartRequired: false,
        selfCheck,
        error: this.activeStorage === 'persistent'
          ? 'Persistent Ekko storage is active; database repair is only allowed from ephemeral recovery mode.'
          : 'The persistent database already passes self-check; reload Ekko Setup at a completed-run boundary to leave ephemeral mode.',
      }
    }
    if (strategy === 'rebuild' && !confirmed) {
      const selfCheck = this.selfCheck('database')
      return {
        ok: false,
        strategy,
        restartRequired: false,
        selfCheck,
        error: 'Database rebuild requires confirmed=true because it quarantines the current database family.',
      }
    }
    const incidentId = this.options.diagnostics.get('database', 'global')?.incidentId
    let backupPath: string | undefined
    let recoveredTables: Array<{ table: string; rows: number }> | undefined
    let skippedTables: Array<{ table: string; reason: string }> | undefined
    try {
      if (strategy === 'rebuild') {
        const original = new EkkoDatabaseManager(this.databaseOptions())
        backupPath = original.quarantineForRebuild()
        const rebuilt = new EkkoDatabaseManager(this.databaseOptions())
        try {
          const memory = initializeStores(rebuilt)
          const recovery = rebuilt.recoverCompatibleTables(
            backupPath,
            EKKO_RECOVERABLE_DATABASE_TABLES,
          )
          memory.rebuildSearchIndex()
          recoveredTables = recovery.recoveredTables
          skippedTables = recovery.skippedTables
        } catch (error) {
          rebuilt.close()
          const restorer = new EkkoDatabaseManager(this.databaseOptions())
          restorer.restoreQuarantinedDatabase(backupPath)
          restorer.close()
          throw error
        } finally {
          rebuilt.close()
        }
      } else {
        const manager = new EkkoDatabaseManager(this.databaseOptions())
        try {
          initializeStores(manager)
        } finally {
          manager.close()
        }
      }
    } catch (error) {
      this.recordDatabaseFailure(`repair.${strategy}`, error)
      return {
        ok: false,
        strategy,
        ...(backupPath ? { backupPath } : {}),
        restartRequired: false,
        selfCheck: this.selfCheck('database'),
        error: error instanceof Error ? error.message : String(error),
      }
    }

    const selfCheck = this.selfCheck('database')
    this.targetReady = selfCheck.ok
    if (selfCheck.ok) {
      this.options.diagnostics.resolve('database', 'global', selfCheck, incidentId)
    } else {
      this.recordDatabaseFailure(`self_check_after_${strategy}`, new Error(
        selfCheck.checks.filter(check => !check.ok).map(check => check.detail).join('; '),
      ))
    }
    return {
      ok: selfCheck.ok,
      strategy,
      ...(backupPath ? { backupPath } : {}),
      ...(recoveredTables ? { recoveredTables } : {}),
      ...(skippedTables ? { skippedTables } : {}),
      restartRequired: selfCheck.ok && this.activeStorage === 'ephemeral',
      selfCheck,
    }
  }

  private checkSkills(profile: string): EkkoSelfCheckResult {
    const checkedAt = new Date().toISOString()
    try {
      const check = this.options.directories.checkProfileSkills(profile)
      return {
        ok: check.ok,
        component: 'skills',
        checkedAt,
        checks: [{ name: 'bundled_skills_readable', ok: check.ok, detail: check.detail }],
        metadata: { ...check },
      }
    } catch (error) {
      return {
        ok: false,
        component: 'skills',
        checkedAt,
        checks: [{
          name: 'bundled_skills_readable',
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        }],
        metadata: {
          sourceDirectory: this.options.directories.bundledSkillsSourceDirectory(),
          targetDirectory: this.options.directories.profileSkillsPath(profile),
        },
      }
    }
  }

  private checkDatabase(): EkkoSelfCheckResult {
    const checkedAt = new Date().toISOString()
    const checks: EkkoSelfCheckResult['checks'] = []
    if (!existsSync(this.options.databasePath)) {
      checks.push({ name: 'database_exists', ok: false, detail: `Database is missing: ${this.options.databasePath}` })
      return { ok: false, component: 'database', checkedAt, checks }
    }
    let database: DatabaseSync | undefined
    try {
      database = new DatabaseSync(this.options.databasePath, { readOnly: true })
      const quickCheck = database.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined
      const quickCheckValue = String(quickCheck?.quick_check || '')
      checks.push({
        name: 'sqlite_quick_check',
        ok: quickCheckValue === 'ok',
        detail: quickCheckValue || 'SQLite returned no quick_check result.',
      })
      const tables = new Set((database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      ).all() as Array<{ name: string }>).map(row => String(row.name)))
      for (const [table, requiredFields] of Object.entries(EKKO_DATABASE_SCHEMA_BLUEPRINT.tables)) {
        const present = tables.has(table)
        checks.push({
          name: `table:${table}`,
          ok: present,
          detail: present ? `${table} is present.` : `${table} is missing.`,
        })
        if (!present) continue
        const actualFields = new Set((database.prepare(
          `PRAGMA table_info("${table}")`,
        ).all() as Array<{ name: string }>).map(row => String(row.name)))
        const missingFields = requiredFields.filter(field => !actualFields.has(field))
        checks.push({
          name: `fields:${table}`,
          ok: !missingFields.length,
          detail: missingFields.length
            ? `${table} is missing fields: ${missingFields.join(', ')}.`
            : `${table} contains every required field.`,
        })
      }
      const migrations = database.prepare(
        'SELECT component, max(version) AS version FROM schema_migrations GROUP BY component',
      ).all() as Array<{ component: string; version: number }>
      const versions = new Map(migrations.map(row => [String(row.component), Number(row.version)]))
      for (const [component, version] of [['memory', 8], ['conversations', 1]] as const) {
        const actual = versions.get(component) || 0
        checks.push({
          name: `migration:${component}`,
          ok: actual >= version,
          detail: `${component} migration=${actual}, required>=${version}.`,
        })
      }
    } catch (error) {
      checks.push({
        name: 'database_readable',
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      })
    } finally {
      database?.close()
    }
    return { ok: checks.every(check => check.ok), component: 'database', checkedAt, checks }
  }

  private checkMemory(): EkkoSelfCheckResult {
    const checkedAt = new Date().toISOString()
    if (!this.memorySelfCheck) {
      return {
        ok: false,
        component: 'memory',
        checkedAt,
        checks: [{
          name: 'active_memory_store',
          ok: false,
          detail: 'The active memory store self-check is not configured.',
        }],
      }
    }
    try {
      const result = this.memorySelfCheck()
      return {
        ok: result.ok,
        component: 'memory',
        checkedAt,
        checks: [{ name: 'active_memory_store', ...result }],
        metadata: { activeStorage: this.activeStorage },
      }
    } catch (error) {
      return {
        ok: false,
        component: 'memory',
        checkedAt,
        checks: [{
          name: 'active_memory_store',
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        }],
        metadata: { activeStorage: this.activeStorage },
      }
    }
  }

  private checkLogs(profile: string): EkkoSelfCheckResult {
    const checkedAt = new Date().toISOString()
    const targetDirectory = this.options.directories.profileLogsPath(profile)
    try {
      const stat = statSync(targetDirectory)
      if (!stat.isDirectory()) throw new Error(`Ekko Profile log path is not a directory: ${targetDirectory}`)
      accessSync(targetDirectory, constants.R_OK | constants.W_OK | constants.X_OK)
      return {
        ok: true,
        component: 'logs',
        checkedAt,
        checks: [{
          name: 'profile_log_directory_writable',
          ok: true,
          detail: `Profile log directory is writable: ${targetDirectory}`,
        }],
        metadata: { profile, targetDirectory },
      }
    } catch (error) {
      return {
        ok: false,
        component: 'logs',
        checkedAt,
        checks: [{
          name: 'profile_log_directory_writable',
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        }],
        metadata: { profile, targetDirectory },
      }
    }
  }

  private databaseOptions() {
    return { databasePath: this.options.databasePath, env: this.options.env }
  }
}

function initializeStores(database: EkkoDatabaseManager): SqliteMemoryStore {
  const memory = new SqliteMemoryStore(database)
  new EkkoConversationStore(database)
  memory.rebuildSearchIndex()
  return memory
}

function safeSkillCheck(directories: EkkoDirectoryManager, profile: string) {
  try {
    return directories.checkProfileSkills(profile)
  } catch (error) {
    return {
      ok: false,
      sourceDirectory: directories.bundledSkillsSourceDirectory(),
      targetDirectory: directories.profileSkillsPath(profile),
      bundledSkillCount: 0,
      missing: [],
      unreadable: [],
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

function databaseSchemaFields(): Record<string, string[]> {
  return Object.fromEntries(Object.entries(EKKO_DATABASE_SCHEMA_BLUEPRINT.tables)
    .map(([table, fields]) => [table, [...fields]]))
}
