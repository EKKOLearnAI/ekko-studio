import { randomUUID } from 'node:crypto'
import { DshPluginError } from './errors'
import type { DshManagement } from './management'

export interface DshAgentPreset { id: string; name?: string; description?: string; trust?: 'system' | 'user'; isDefault: boolean; broken?: string }
export interface DshAgentPresets { presets: DshAgentPreset[]; authorable: boolean }

/** Vue owns presentation; the existing native host owns preset discovery and writes. */
export class DshAgentPresetService {
  constructor(private management: DshManagement) {}
  private async call<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    const target = await this.management.open()
    const rpcId = randomUUID()
    let message: any
    try {
      const response = await fetch(`${target.endpoint}/api/${method}`, {
        method: 'POST', headers: { cookie: target.cookie, origin: target.endpoint, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }), signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) throw new Error('Native transport failed')
      message = await response.json()
      if (message.type !== 'server-response' || message.rpcId !== rpcId || typeof message.result?.ok !== 'boolean') throw new Error('Invalid native response')
    } catch { throw new DshPluginError(502, 'DSH_PRESET_UNAVAILABLE', 'Unable to reach the DSH preset service') }
    if (!message.result.ok) {
      const code = message.result.error?.code
      const status = code === 'agent-preset/not-found' ? 404 : code === 'agent-preset/read-only' ? 403 : code === 'agent-preset/invalid' ? 422 : 502
      throw new DshPluginError(status, 'DSH_PRESET_OPERATION_FAILED', message.result.error?.message || 'DSH preset operation failed')
    }
    return message.result.value
  }
  private id(value: unknown): string {
    if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(value) || value.length > 200) throw new DshPluginError(400, 'DSH_PRESET_INVALID', 'Invalid preset identifier')
    return value
  }
  private nativeList() { return this.call<{ presets: DshAgentPreset[]; authorable?: boolean }>('agentPresets/list') }
  private async requireLegacyAuthoring() {
    if (typeof (await this.nativeList()).authorable !== 'boolean') throw new DshPluginError(422, 'DSH_CAPABILITY_UNSUPPORTED', 'This DSH installation manages preset declarations through native plugin configuration')
  }
  async list() {
    const result = await this.nativeList()
    // Declaration-based DSH exposes selection/read APIs, not the legacy
    // filesystem authoring methods. Do not advertise unsupported operations.
    return { ...result, authorable: result.authorable === true }
  }
  async choices() {
    const { presets } = await this.list()
    return { presets: presets.map(({ id, name, description, isDefault, broken }) => ({ id, name, description, isDefault, ...(broken ? { unavailable: true } : {}) })) }
  }
  async forSession(requested: unknown, stored?: string) {
    // The first launch fixes the preset, including across model/process changes.
    if (stored) return this.id(stored)
    const selected = requested === undefined ? undefined : this.id(requested)
    const { presets } = await this.list()
    const preset = selected ? presets.find(row => row.id === selected) : presets.find(row => row.isDefault)
    if (!preset || preset.broken) throw new DshPluginError(422, 'DSH_PRESET_INVALID', 'Select an available DSH Agent preset')
    return preset.id
  }
  async read(id: unknown) { return this.call<{ agentPreset: string; content: string; name?: string; trust?: 'system' | 'user' }>('agentPresets/read', { agentPreset: this.id(id) }) }
  async copy(body: unknown) {
    const value = body as Record<string, unknown> | null
    if (!value || typeof value !== 'object' || Array.isArray(value) || (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 200))) throw new DshPluginError(400, 'DSH_PRESET_INVALID', 'Invalid preset copy request')
    const from = this.id(value.from), id = this.id(value.id)
    await this.requireLegacyAuthoring()
    await this.call('agentPresets/copy', { from, id, ...(typeof value.name === 'string' && value.name.trim() ? { name: value.name.trim() } : {}) })
    return this.list()
  }
  async remove(id: unknown) {
    const selected = this.id(id)
    await this.requireLegacyAuthoring()
    await this.call('agentPresets/deletePreset', { id: selected })
    return this.list()
  }
  async makeDefault(id: unknown) {
    const selected = this.id(id)
    const roster = await this.nativeList()
    const row = roster.presets.find(preset => preset.id === selected)
    if (!row || row.broken) throw new DshPluginError(422, 'DSH_PRESET_INVALID', 'Select an available preset')
    await this.call('settings/update', typeof roster.authorable === 'boolean'
      ? { ns: 'agent-presets', patch: { default: selected } }
      : { ns: 'agent-preset-registry', patch: { selectedDefault: selected } })
    return this.list()
  }
  async openLocation(id: unknown) {
    const agentPreset = this.id(id)
    await this.requireLegacyAuthoring()
    return this.call<{ path?: string; opened: boolean }>('settings/openAgentPresetDirectory', { agentPreset })
  }
}
