import { config } from '../../public/config'
import type { PluginIdentity } from '../../contracts/plugins'
import type { PluginAgentRuntime } from '../plugins/agent-runtime'
import { PluginError } from '../plugins/errors'
import { pluginAgentRuntimes } from './registry'
import { AgentUpdatePolicy } from './update-policy'

/** Uses the same idle grace and persistence rules as native Coding Agents. */
export class PluginAgentUpdates {
  readonly policy: AgentUpdatePolicy
  private eligible = new Map<PluginAgentRuntime, boolean>()
  private runtimes = new Map<string, PluginAgentRuntime>()
  private loaded: Promise<void>
  private timer?: ReturnType<typeof setInterval>
  constructor(home: string, private agents: () => PluginAgentRuntime[] = pluginAgentRuntimes) {
    this.policy = new AgentUpdatePolicy(home, {
      ids: () => this.agents().map(agent => agent.id),
      safelyManaged: id => Boolean(this.eligible.get(this.find(id))),
      busy: id => this.find(id).isBusyForUpdate(),
      activityRevision: id => this.find(id).activityRevision(),
      check: async id => {
        const agent = this.find(id), identity = agent.owner.identity
        const tool = await agent.status(identity)
        if (!tool.installed || !agent.definition.management.checkUpdate) return { success: true, tool, latestVersion: tool.version, updateAvailable: false }
        return { success: true, tool, ...await agent.checkUpdate(identity) }
      },
      install: async id => {
        const agent = this.find(id), identity = agent.owner.identity
        const update = this.policy.snapshot()[id]
        await agent.upgrade(identity, { version: update.latestVersion, expectedVersion: update.currentVersion }, { automatic: true })
        return { success: true, tool: await agent.status(identity) }
      },
    }, 'plugin-agent-update-policy.json')
    this.loaded = this.policy.load()
  }
  private find(id: string) {
    const agent = this.agents().find(agent => agent.id === id)
    if (!agent) throw new PluginError('Agent plugin is disabled or unavailable', 'AGENT_UNAVAILABLE', 409)
    return agent
  }
  private async refreshCapabilities(id?: string) {
    const current = this.agents()
    const selected = id ? [this.find(id)] : current
    for (const agent of selected) if (this.runtimes.get(agent.id) !== agent) {
      this.policy.invalidate(agent.id)
      this.runtimes.set(agent.id, agent)
    }
    await Promise.all(selected.map(async agent => {
      try {
        const status = await agent.status(agent.owner.identity)
        const supported = status.installed && await agent.supportsAutoUpdate(agent.owner.identity)
        if (this.runtimes.get(agent.id) === agent) this.eligible.set(agent, supported)
      } catch { if (this.runtimes.get(agent.id) === agent) this.eligible.set(agent, false) }
    }))
    const live = this.agents()
    for (const agent of this.eligible.keys()) if (!live.includes(agent)) this.eligible.delete(agent)
    for (const [key, agent] of this.runtimes) if (!live.includes(agent)) { this.runtimes.delete(key); this.policy.invalidate(key) }
  }
  async checkUpdate(id: string, identity: PluginIdentity) {
    const agent = this.find(id)
    await this.loaded; await this.refreshCapabilities(id)
    if (identity.userId !== agent.owner.identity.userId || identity.profile !== agent.owner.identity.profile) {
      // Profile-specific checks cannot become the target for host-wide automatic updates.
      const result = await agent.checkUpdate(identity)
      await this.policy.checkNow(id).catch(() => {})
      return result
    }
    const result = await this.policy.checkNow(id, false, async () => {
      const tool = await agent.status(identity), update = await agent.checkUpdate(identity)
      return { success: true, tool: { ...tool, version: update.currentVersion }, ...update }
    })
    return { currentVersion: result.tool.version, latestVersion: result.latestVersion, updateAvailable: result.updateAvailable, ...(result.message ? { message: result.message } : {}) }
  }
  async snapshot(id: string, identity?: PluginIdentity) {
    const agent = this.find(id)
    await this.loaded; await this.refreshCapabilities(id)
    const state = this.policy.snapshot()[id]
    if (identity && (identity.userId !== agent.owner.identity.userId || identity.profile !== agent.owner.identity.profile)) {
      const supported = (await agent.status(identity)).installed && await agent.supportsAutoUpdate(identity)
      return { ...state, autoUpdate: state.autoUpdate && supported, autoUpdateSupported: state.autoUpdateSupported && supported }
    }
    return state
  }
  async set(id: string, enabled: unknown, identity?: PluginIdentity) {
    const visible = await this.snapshot(id, identity)
    if (enabled === true && !visible.autoUpdateSupported) throw new PluginError('Automatic updates are not supported for this installation', 'AGENT_UNSUPPORTED', 400)
    try { await this.policy.set(id, enabled) }
    catch (error) { throw new PluginError(error instanceof Error ? error.message : 'Invalid update policy', 'AGENT_UPDATE_POLICY', 400) }
    return { ...this.policy.snapshot()[id], autoUpdateSupported: visible.autoUpdateSupported }
  }
  async upgrade(id: string, identity: PluginIdentity, input: { version: string; expectedVersion: string }) {
    this.find(id)
    await this.loaded
    let result: unknown
    await this.policy.installAndRefresh(id, async () => {
      const agent = this.find(id)
      result = await agent.upgrade(identity, input)
      await this.refreshCapabilities(id)
      return { success: true, tool: await agent.status(identity) }
    })
    return result
  }
  async remove(id: string, identity: PluginIdentity, input: { expectedVersion: string }) {
    this.find(id)
    await this.loaded
    await this.policy.installAndRefresh(id, async () => {
      const agent = this.find(id)
      await agent.remove(identity, input)
      await this.refreshCapabilities(id)
      return { success: true, tool: await agent.status(identity) }
    })
    await this.policy.set(id, false)
    return { removed: true }
  }
  async tick(force = false) { await this.loaded; await this.refreshCapabilities(); await this.policy.tick(force) }
  start() {
    if (this.timer) return
    void this.tick().catch(() => {})
    this.timer = setInterval(() => { void this.tick().catch(() => {}) }, 60_000)
    this.timer.unref()
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined }
}
let updates: PluginAgentUpdates | undefined
export function getPluginAgentUpdates() { return updates ||= new PluginAgentUpdates(config.appHome) }
