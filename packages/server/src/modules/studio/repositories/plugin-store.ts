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

export interface PluginProfileState {
  pluginId: string
  profileId: string
  enabled: boolean
  ownerId: string
  config: JsonObject
  grants: string[]
  revision: number
}
export interface PluginDiagnostic {
  pluginId: string; profileId: string; configurationRevision: number
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
    );`)
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
    // Profile configuration is retained for reinstall; history is owned by Studio.
    this.db.prepare("DELETE FROM studio_plugin_installations WHERE id = ? AND policy = 'user'").run(id)
  }

  profile(pluginId: string, profileId: string): PluginProfileState | null {
    const row = this.db.prepare('SELECT * FROM studio_plugin_profiles WHERE plugin_id = ? AND profile_id = ?').get(pluginId, profileId) as unknown as ProfileRow | undefined
    return row ? { pluginId, profileId, enabled: row.enabled === 1, ownerId: row.owner_id,
      config: JSON.parse(row.config_json) as JsonObject, grants: JSON.parse(row.grants_json) as string[], revision: row.revision } : null
  }

  saveProfile(input: Omit<PluginProfileState, 'revision'>, expectedRevision: number): PluginProfileState {
    if (!this.get(input.pluginId)) throw new StudioError('NOT_FOUND', 'Plugin is not installed')
    const old = this.profile(input.pluginId, input.profileId)
    if ((old?.revision || 0) !== expectedRevision) throw new StudioError('REVISION_CONFLICT', 'Plugin profile changed')
    if (!old) {
      this.db.prepare(`INSERT INTO studio_plugin_profiles (plugin_id, profile_id, enabled, owner_id, config_json, grants_json)
        VALUES (?, ?, ?, ?, ?, ?)`).run(input.pluginId, input.profileId, Number(input.enabled), input.ownerId, JSON.stringify(input.config), JSON.stringify(input.grants))
    } else {
      const result = this.db.prepare(`UPDATE studio_plugin_profiles SET enabled=?, owner_id=?, config_json=?, grants_json=?, revision=revision+1
        WHERE plugin_id=? AND profile_id=? AND revision=?`).run(Number(input.enabled), input.ownerId, JSON.stringify(input.config), JSON.stringify(input.grants), input.pluginId, input.profileId, expectedRevision)
      if (!result.changes) throw new StudioError('REVISION_CONFLICT', 'Plugin profile changed')
    }
    return this.profile(input.pluginId, input.profileId)!
  }

  enabledProfiles(): PluginProfileState[] {
    const rows = this.db.prepare('SELECT plugin_id, profile_id FROM studio_plugin_profiles WHERE enabled=1').all() as Array<{ plugin_id: string; profile_id: string }>
    return rows.map(row => this.profile(row.plugin_id, row.profile_id)!)
  }

  diagnostic(pluginId: string, profileId: string): PluginDiagnostic | null {
    const row = this.db.prepare(`SELECT plugin_id AS pluginId, profile_id AS profileId, configuration_revision AS configurationRevision,
      state, error_code AS errorCode, updated_at AS updatedAt FROM studio_plugin_diagnostics WHERE plugin_id=? AND profile_id=?`).get(pluginId, profileId)
    return row ? row as unknown as PluginDiagnostic : null
  }

  recordDiagnostic(pluginId: string, profileId: string, state: PluginDiagnostic['state'], errorCode: StudioErrorCode | null = null): void {
    this.db.prepare(`INSERT INTO studio_plugin_diagnostics VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(plugin_id, profile_id) DO UPDATE SET configuration_revision=excluded.configuration_revision,
      state=excluded.state, error_code=excluded.error_code, updated_at=excluded.updated_at`)
      .run(pluginId, profileId, this.profile(pluginId, profileId)?.revision || 0, state, errorCode, Date.now())
  }

  private decode(row: InstallationRow): PluginInstallation {
    const system = isSystemPluginId(row.id) || row.policy === 'system'
    return { id: row.id, manifest: JSON.parse(row.manifest_json) as PluginManifest, generation: row.generation, artifactPath: row.artifact_path,
      origin: row.origin, installationPolicy: system ? { kind: 'system', removable: false } : { kind: 'user', removable: true }, revision: row.revision }
  }
}
