import { dirname, resolve } from 'node:path'
import { StudioError } from '../../contracts/plugins'
import type { PluginHost } from './host'
import type { PluginStore } from '../../repositories/plugin-store'

// Trusted distribution artifacts. Registration never installs the native CLI.
const bundles = [
  { id: 'qwen', name: 'Qwen Code', pluginId: 'studio.agent-qwen', directory: 'qwen-code' },
  { id: 'codex', name: 'Codex', pluginId: 'studio.agent-codex', directory: 'codex' },
  { id: 'kimi', name: 'Kimi Code', pluginId: 'studio.agent-kimi', directory: 'kimi' },
  { id: 'qoder', name: 'Qoder', pluginId: 'studio.agent-qoder', directory: 'qoder',
    requiredCapabilities: ['agents.register', 'commands.register', 'runs.start', 'processes.spawn', 'mcp.studio', 'artifacts.read'] },
  { id: 'codebuddy', name: 'CodeBuddy', pluginId: 'studio.agent-codebuddy', directory: 'codebuddy' },
  { id: 'copilot', name: 'GitHub Copilot', pluginId: 'studio.agent-copilot', directory: 'copilot' },
  { id: 'opencode', name: 'OpenCode', pluginId: 'studio.agent-opencode', directory: 'opencode' },
  { id: 'pi', name: 'Pi', pluginId: 'studio.agent-pi', directory: 'pi' },
  { id: 'dsh', name: 'DeepSeek Harness', pluginId: 'studio.agent-dsh', directory: 'dsh' },
  { id: 'claude-code', name: 'Claude Code', pluginId: 'studio.agent-claude-code', directory: 'claude-code' },
  { id: 'antigravity', name: 'Antigravity', pluginId: 'studio.agent-antigravity', directory: 'antigravity',
    requiredCapabilities: ['agents.register', 'runs.start', 'processes.spawn', 'mcp.studio', 'models.gateway', 'artifacts.read'] },
  { id: 'cursor', name: 'Cursor', pluginId: 'studio.agent-cursor', directory: 'cursor',
    requiredCapabilities: ['agents.register', 'runs.start', 'processes.spawn', 'mcp.studio', 'artifacts.read'] },
  { id: 'grok', name: 'Grok', pluginId: 'studio.agent-grok', directory: 'grok' },
  { id: 'zcode', name: 'ZCode', pluginId: 'studio.agent-zcode', directory: 'zcode' },
] as const
const bundledCapabilities = ['agents.register', 'commands.register', 'runs.start', 'processes.spawn', 'mcp.studio', 'models.gateway', 'artifacts.read']

export class BundledAgentPlugins {
  private pending = new Map<string, Promise<unknown>>()
  private closed = false
  constructor(private host: PluginHost, private store: PluginStore, private runnerPath: string, private authorize: (ownerId: string) => void) {}

  async registerDefaults(): Promise<void> {
    for (const bundle of bundles) {
      if (this.closed) throw new StudioError('RUNTIME_UNAVAILABLE', 'Plugin setup is shutting down')
      await this.host.registerSystemArtifact(resolve(dirname(this.runnerPath), '../plugins', bundle.directory), bundle.pluginId,
        () => { if (this.closed) throw new StudioError('RUNTIME_UNAVAILABLE', 'Plugin setup is shutting down') })
      if (!this.store.state(bundle.pluginId)) {
        const installed = this.store.get(bundle.pluginId)!
        this.store.saveState({ pluginId: bundle.pluginId, enabled: true, config: {}, grants: [...installed.manifest.requires.capabilities] }, 0)
      }
    }
  }

  list(_legacyProfileId?: string) {
    return bundles.map(bundle => {
      const profile = this.store.state(bundle.pluginId), installed = this.store.get(bundle.pluginId)
      return { id: bundle.id, name: bundle.name, pluginId: bundle.pluginId, installed: !!installed,
        revision: profile?.revision || 0, enabled: profile?.enabled || false,
        requiredCapabilities: installed?.manifest.requires.capabilities || [...('requiredCapabilities' in bundle ? bundle.requiredCapabilities : bundledCapabilities)],
        state: installed ? this.host.diagnostic(bundle.pluginId).state : 'not_installed' }
    })
  }

  /** Trusted application entry: selecting a shipped Agent needs no setup form.
   * Global disable and narrowed grants remain authoritative. */
  async ensure(id: string, authorizeCaller: () => void): Promise<void> {
    const bundle = bundles.find(value => value.id === id)
    if (!bundle) throw new StudioError('NOT_FOUND', 'Bundled Agent plugin is unavailable')
    const authorize = () => {
      if (this.closed) throw new StudioError('RUNTIME_UNAVAILABLE', 'Plugin setup is shutting down')
      authorizeCaller()
    }
    authorize()
    const pending = this.pending.get(bundle.pluginId)
    if (pending) { await pending; authorize(); return this.ensure(id, authorizeCaller) }
    const task = Promise.resolve().then(async () => {
      authorize()
      const installed = this.store.get(bundle.pluginId) || await this.host.registerSystemArtifact(
        resolve(dirname(this.runnerPath), '../plugins', bundle.directory), bundle.pluginId, authorize)
      authorize()
      if (installed.id !== bundle.pluginId || installed.installationPolicy.kind !== 'system') throw new StudioError('PLUGIN_UNAVAILABLE', 'Bundled Agent artifact identity does not match')
      const current = this.store.state(bundle.pluginId)
      if (!current) await this.host.configure({ pluginId: bundle.pluginId, enabled: true, config: {}, grants: [...installed.manifest.requires.capabilities] }, 0, authorize)
      else {
        if (!current.enabled || installed.manifest.requires.capabilities.some(capability => !current.grants.includes(capability))) throw new StudioError('PLUGIN_UNAVAILABLE', 'Agent plugin is disabled or its permissions were revoked')
        if (this.host.diagnostic(bundle.pluginId).state !== 'ready') await this.host.activate(bundle.pluginId)
      }
      authorize()
    })
    this.pending.set(bundle.pluginId, task)
    try { await task } finally { if (this.pending.get(bundle.pluginId) === task) this.pending.delete(bundle.pluginId) }
  }

  async enable(id: string, ownerId: string, revision: number, grants?: string[]) {
    const authorize = () => {
      if (this.closed) throw new StudioError('RUNTIME_UNAVAILABLE', 'Plugin setup is shutting down')
      this.authorize(ownerId)
    }
    authorize()
    const bundle = bundles.find(value => value.id === id)
    if (!bundle) throw new StudioError('NOT_FOUND', 'Bundled Agent plugin is unavailable')
    if (!Number.isSafeInteger(revision) || revision < 0) throw new StudioError('INVALID_ARGUMENT', 'Plugin configuration revision is required')
    if (grants !== undefined && (!Array.isArray(grants) || grants.length > 128 || grants.some(value => typeof value !== 'string' || value.length > 256)
      || new Set(grants).size !== grants.length)) throw new StudioError('INVALID_ARGUMENT', 'Invalid plugin permission selection')
    const selectedGrants = grants?.slice()
    if (this.pending.has(bundle.pluginId)) throw new StudioError('REVISION_CONFLICT', 'Bundled Agent plugin is being configured')
    const task = Promise.resolve().then(async () => {
      authorize()
      const current = this.store.state(bundle.pluginId)
      if ((current?.revision || 0) !== revision) throw new StudioError('REVISION_CONFLICT', 'Plugin configuration changed')
      const existing = this.store.get(bundle.pluginId)
      const installed = existing || await this.host.registerSystemArtifact(resolve(dirname(this.runnerPath), '../plugins', bundle.directory), bundle.pluginId, authorize)
      authorize()
      if (installed.id !== bundle.pluginId || installed.installationPolicy.kind !== 'system') throw new StudioError('PLUGIN_UNAVAILABLE', 'Bundled Agent artifact identity does not match')
      const required = installed.manifest.requires.capabilities
      if (selectedGrants && (selectedGrants.length !== required.length || selectedGrants.some(value => !required.includes(value)))) throw new StudioError('REVISION_CONFLICT', 'Required plugin permissions changed; reload before authorizing')
      return this.host.configure({ pluginId: bundle.pluginId, enabled: true,
        config: current?.config || {}, grants: selectedGrants || current?.grants || [...required] }, revision, authorize)
    })
    this.pending.set(bundle.pluginId, task)
    try { return await task } finally { this.pending.delete(bundle.pluginId) }
  }

  async close() { this.closed = true; await Promise.allSettled([...this.pending.values()]) }
}
