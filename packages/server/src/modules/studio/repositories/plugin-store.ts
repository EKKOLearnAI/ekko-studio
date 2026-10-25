import { isDeepStrictEqual } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import { StudioError, type JsonObject, type PluginManifest, type PluginInstallationPolicy, type StudioErrorCode } from '../contracts/plugins'
import { isSystemPluginId } from '../contracts/system-plugins'

export interface PluginInstallation {
  id: string
  manifest: PluginManifest
  generation: string
  artifactPath: string
  origin: 'bundled' | 'installed'
  installationPolicy: PluginInstallationPolicy
  revision: number
}

export interface PluginState {
  pluginId: string
  enabled: boolean
  config: JsonObject
  grants: string[]
  revision: number
}
export interface PluginDiagnostic {
  pluginId: string; configurationRevision: number
  state: 'inactive' | 'disabled' | 'activating' | 'ready' | 'blocked' | 'failed'
  errorCode: StudioErrorCode | null; updatedAt: number
}

interface InstallationRow {
  id: string; manifest_json: string; generation: string; artifact_path: string;
  origin: 'bundled' | 'installed'; policy: 'system' | 'user'; revision: number
}
interface ProfileRow {
  plugin_id: string; profile_id: string; enabled: number; owner_id: string;
  config_json: string; grants_json: string; revision: number
}

export class PluginStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS studio_plugin_installations (
      id TEXT PRIMARY KEY, manifest_json TEXT NOT NULL, generation TEXT NOT NULL,
      artifact_path TEXT NOT NULL, origin TEXT NOT NULL CHECK(origin IN ('bundled','installed')),
      policy TEXT NOT NULL CHECK(policy IN ('system','user')), revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS studio_plugin_profiles (
      plugin_id TEXT NOT NULL, profile_id TEXT NOT NULL, enabled INTEGER NOT NULL,
      owner_id TEXT NOT NULL, config_json TEXT NOT NULL, grants_json TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(plugin_id, profile_id)
    );
    CREATE TABLE IF NOT EXISTS studio_plugin_diagnostics (
      plugin_id TEXT NOT NULL, profile_id TEXT NOT NULL, configuration_revision INTEGER NOT NULL,
      state TEXT NOT NULL, error_code TEXT, updated_at INTEGER NOT NULL,
      PRIMARY KEY(plugin_id, profile_id)
    );
    CREATE TABLE IF NOT EXISTS studio_plugin_states (
      plugin_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, config_json TEXT NOT NULL,
      grants_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS studio_plugin_runtime_diagnostics (
      plugin_id TEXT PRIMARY KEY, configuration_revision INTEGER NOT NULL,
      state TEXT NOT NULL, error_code TEXT, updated_at INTEGER NOT NULL
    );`)
    this.migrateProfileStates()
  }

  get(id: string): PluginInstallation | null {
    const row = this.db.prepare('SELECT * FROM studio_plugin_installations WHERE id = ?').get(id) as unknown as InstallationRow | undefined
    return row ? this.decode(row) : null
  }

  list(): PluginInstallation[] {
    return (this.db.prepare('SELECT * FROM studio_plugin_installations ORDER BY id').all() as unknown as InstallationRow[]).map(row => this.decode(row))
  }

  registerSystem(input: Omit<PluginInstallation, 'origin' | 'installationPolicy' | 'revision'>): PluginInstallation {
    if (!isSystemPluginId(input.id)) throw new StudioError('INVALID_ARGUMENT', 'Unknown system distribution id')
    const old = this.get(input.id)
    if (old && old.generation === input.generation && old.artifactPath === input.artifactPath && old.installationPolicy.kind === 'system') return old
    this.db.prepare(`INSERT INTO studio_plugin_installations (id, manifest_json, generation, artifact_path, origin, policy)
      VALUES (?, ?, ?, ?, 'bundled', 'system') ON CONFLICT(id) DO UPDATE SET
      manifest_json=excluded.manifest_json, generation=excluded.generation, artifact_path=excluded.artifact_path,
      origin='bundled', policy='system', revision=studio_plugin_installations.revision+1`)
      .run(input.id, JSON.stringify(input.manifest), input.generation, input.artifactPath)
    return this.get(input.id)!
  }

  installUser(input: Omit<PluginInstallation, 'origin' | 'installationPolicy' | 'revision'>): PluginInstallation {
    if (isSystemPluginId(input.id) || this.get(input.id)?.installationPolicy.kind === 'system') throw new StudioError('SYSTEM_PLUGIN_PROTECTED', 'System plugins cannot be replaced through user installation')
    if (this.get(input.id)) throw new StudioError('REVISION_CONFLICT', 'Plugin is already installed')
    this.db.prepare(`INSERT INTO studio_plugin_installations (id, manifest_json, generation, artifact_path, origin, policy)
      VALUES (?, ?, ?, ?, 'installed', 'user')`).run(input.id, JSON.stringify(input.manifest), input.generation, input.artifactPath)
    return this.get(input.id)!
  }

  assertRemovable(id: string): PluginInstallation {
    if (isSystemPluginId(id)) throw new StudioError('SYSTEM_PLUGIN_PROTECTED', 'System plugins cannot be uninstalled')
    const installation = this.get(id)
    if (!installation) throw new StudioError('NOT_FOUND', 'Plugin is not installed')
    if (!installation.installationPolicy.removable) throw new StudioError('SYSTEM_PLUGIN_PROTECTED', 'System plugins cannot be uninstalled')
    return installation
  }

  remove(id: string): void {
    this.assertRemovable(id)
    // Global configuration is retained for reinstall; history is owned by Studio.
    this.db.prepare("DELETE FROM studio_plugin_installations WHERE id = ? AND policy = 'user'").run(id)
  }

  state(pluginId: string): PluginState | null {
    const row = this.db.prepare('SELECT * FROM studio_plugin_states WHERE plugin_id = ?').get(pluginId) as
      { enabled: number; config_json: string; grants_json: string; revision: number } | undefined
    return row ? { pluginId, enabled: row.enabled === 1, config: JSON.parse(row.config_json),
      grants: JSON.parse(row.grants_json), revision: row.revision } : null
  }

  saveState(input: Omit<PluginState, 'revision'>, expectedRevision: number): PluginState {
    if (!this.get(input.pluginId)) throw new StudioError('NOT_FOUND', 'Plugin is not installed')
    const old = this.state(input.pluginId)
    if ((old?.revision || 0) !== expectedRevision) throw new StudioError('REVISION_CONFLICT', 'Global plugin configuration changed')
    if (!old) {
      this.db.prepare('INSERT INTO studio_plugin_states (plugin_id, enabled, config_json, grants_json) VALUES (?, ?, ?, ?)')
        .run(input.pluginId, Number(input.enabled), JSON.stringify(input.config), JSON.stringify(input.grants))
    } else {
      const result = this.db.prepare(`UPDATE studio_plugin_states SET enabled=?, config_json=?, grants_json=?, revision=revision+1
        WHERE plugin_id=? AND revision=?`).run(Number(input.enabled), JSON.stringify(input.config), JSON.stringify(input.grants), input.pluginId, expectedRevision)
      if (!result.changes) throw new StudioError('REVISION_CONFLICT', 'Global plugin configuration changed')
    }
    return this.state(input.pluginId)!
  }

  enabled(): PluginState[] {
    return (this.db.prepare('SELECT plugin_id FROM studio_plugin_states WHERE enabled=1 ORDER BY plugin_id').all() as Array<{ plugin_id: string }>)
      .map(row => this.state(row.plugin_id)!)
  }

  diagnostic(pluginId: string): PluginDiagnostic | null {
    const row = this.db.prepare(`SELECT plugin_id AS pluginId, configuration_revision AS configurationRevision,
      state, error_code AS errorCode, updated_at AS updatedAt FROM studio_plugin_runtime_diagnostics WHERE plugin_id=?`).get(pluginId)
    return row ? row as unknown as PluginDiagnostic : null
  }

  recordDiagnostic(pluginId: string, state: PluginDiagnostic['state'], errorCode: StudioErrorCode | null = null): void {
    this.db.prepare(`INSERT INTO studio_plugin_runtime_diagnostics VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(plugin_id) DO UPDATE SET configuration_revision=excluded.configuration_revision,
      state=excluded.state, error_code=excluded.error_code, updated_at=excluded.updated_at`)
      .run(pluginId, this.state(pluginId)?.revision || 0, state, errorCode, Date.now())
  }

  /** Read old data once. Disagreeing configurations remain blocked for explicit reconciliation.
   * The old rows are retained for rollback and never serve as runtime ownership. */
  private migrateProfileStates(): void {
    const ids = this.db.prepare(`SELECT DISTINCT plugin_id FROM studio_plugin_profiles
      WHERE plugin_id NOT IN (SELECT plugin_id FROM studio_plugin_states)`).all() as Array<{ plugin_id: string }>
    this.db.exec('SAVEPOINT studio_plugin_global_migration')
    try {
      for (const { plugin_id: id } of ids) {
        const rows = this.db.prepare('SELECT * FROM studio_plugin_profiles WHERE plugin_id=? ORDER BY profile_id').all(id) as unknown as ProfileRow[]
        const first = rows[0]!
        const equal = rows.every(row => row.enabled === first.enabled && isDeepStrictEqual(JSON.parse(row.config_json), JSON.parse(first.config_json))
          && isDeepStrictEqual(JSON.parse(row.grants_json).sort(), JSON.parse(first.grants_json).sort()))
        this.db.prepare('INSERT INTO studio_plugin_states VALUES (?, ?, ?, ?, ?)').run(id,
          equal ? first.enabled : 0, equal ? first.config_json : '{}', equal ? first.grants_json : '[]', Math.max(...rows.map(row => row.revision)))
        if (!equal) this.recordDiagnostic(id, 'blocked', 'REVISION_CONFLICT')
      }
      this.db.exec('RELEASE studio_plugin_global_migration')
    } catch (error) { this.db.exec('ROLLBACK TO studio_plugin_global_migration; RELEASE studio_plugin_global_migration'); throw error }
  }

  /** @deprecated Compatibility for existing host integrations. Scope arguments are ignored. */
  profile(pluginId: string, _profileId?: string): PluginState | null { return this.state(pluginId) }
  /** @deprecated Use saveState; plugin lifecycle has no profile or owner. */
  saveProfile(input: Omit<PluginState, 'revision'> & { profileId?: string; ownerId?: string }, revision: number): PluginState { return this.saveState(input, revision) }

  private decode(row: InstallationRow): PluginInstallation {
    const system = isSystemPluginId(row.id) || row.policy === 'system'
    return { id: row.id, manifest: JSON.parse(row.manifest_json) as PluginManifest, generation: row.generation, artifactPath: row.artifact_path,
      origin: row.origin, installationPolicy: system ? { kind: 'system', removable: false } : { kind: 'user', removable: true }, revision: row.revision }
  }
}
