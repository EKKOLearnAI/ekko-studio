import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { CodingAgentDefinition } from '../../contracts/definition'
import type { CodingAgentModelCatalog, CodingAgentModelsResponse } from '../../contracts/models'
import type { CodingAgentRuntime } from '../../../studio/contracts/agents/runtime'
import { codexModels } from '../codex/models'
import { claudeCodeModels } from '../claude-code/models'
import { piModels } from '../pi/models'
import { grokModels } from '../grok/models'
import { openCodeModels } from '../opencode/models'
import { cursorModels } from '../cursor/models'
import { antigravityModels } from '../antigravity/models'
import { qoderModels } from '../qoder/models'
import { qwenModels } from '../qwen/models'
import { kimiModels } from '../kimi/models'
import { codeBuddyModels } from '../codebuddy/models'
import { copilotModels } from '../copilot/models'
import { dshModels } from '../dsh/models'
import { zcodeModels } from '../zcode/models'
import { createModelDiscoveryContext, type ModelCommand } from './process'
import { discoveryError, normalizeModels, type ModelDiscoveryAdapter } from './types'

const adapters: Record<CodingAgentRuntime, ModelDiscoveryAdapter> = {
  codex: codexModels, 'claude-code': claudeCodeModels, pi: piModels, grok: grokModels,
  opencode: openCodeModels, cursor: cursorModels, antigravity: antigravityModels, qoder: qoderModels,
  qwen: qwenModels, kimi: kimiModels, codebuddy: codeBuddyModels, copilot: copilotModels,
  dsh: dshModels, zcode: zcodeModels,
}

export interface CodingAgentModelsHost {
  definitions: readonly CodingAgentDefinition[]
  commandEnv(): Promise<NodeJS.ProcessEnv>
  resolveCommand(definition: CodingAgentDefinition, env: NodeJS.ProcessEnv): Promise<ModelCommand | null>
  commandExecution(command: string, args: string[]): { command: string; args: string[]; windowsVerbatimArguments?: boolean }
  home(): string
  dataHome(): string
  timeoutMs?: number
}

/** Native model discovery is global to this server's CLI homes, not Hermes Profiles. */
export function createCodingAgentModelDiscovery(host: CodingAgentModelsHost) {
  const cache = new Map<string, { result: CodingAgentModelCatalog; expires: number }>()
  const pending = new Map<string, Promise<CodingAgentModelCatalog>>()
  const queue: Array<() => void> = []
  let active = 0
  async function slot<T>(operation: () => Promise<T>): Promise<T> {
    if (active >= 3) await new Promise<void>(resolve => queue.push(resolve))
    else active++
    try { return await operation() }
    finally {
      const next = queue.shift()
      if (next) next()
      else active--
    }
  }

  async function inspect(definition: CodingAgentDefinition, env: NodeJS.ProcessEnv): Promise<CodingAgentModelCatalog> {
    const adapter = adapters[definition.id]
    const base: CodingAgentModelCatalog = {
      agentId: definition.id, name: definition.name, source: adapter.source, scope: adapter.scope,
      status: 'error', models: [], checkedAt: '', cached: false,
    }
    let cwd: string | undefined
    try {
      const command = await host.resolveCommand(definition, env)
      if (!command) return { ...base, status: 'not_installed', checkedAt: new Date().toISOString() }
      const directory = join(host.dataHome(), 'coding-agent', 'model-discovery')
      await mkdir(directory, { recursive: true })
      cwd = await mkdtemp(join(directory, `${definition.id}-`))
      const context = createModelDiscoveryContext({ command, cwd, home: host.home(), env, host })
      const discovered = await adapter.discover(context)
      const models = normalizeModels(discovered.models)
      return { ...base, models, scope: discovered.scope || adapter.scope,
        status: models.length ? 'ready' : 'empty', checkedAt: new Date().toISOString() }
    } catch (error) {
      return { ...base, status: discoveryError(error).status, checkedAt: new Date().toISOString() }
    } finally {
      if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => {})
    }
  }

  async function catalog(definition: CodingAgentDefinition, env: NodeJS.ProcessEnv, refresh: boolean) {
    // Environment identities include native home overrides and credential changes;
    // only a digest is retained in memory, never a plaintext credential cache key.
    const identity = createHash('sha256').update(JSON.stringify([host.home(), host.dataHome(), Object.entries(env).sort()])).digest('hex')
    const key = `${definition.id}:${identity}`
    const existing = pending.get(key)
    if (existing) return structuredClone(await existing)
    const cached = cache.get(key)
    if (!refresh && cached && cached.expires > Date.now()) return { ...structuredClone(cached.result), cached: true }
    const work = slot(() => inspect(definition, env))
    pending.set(key, work)
    try {
      const result = await work
      if (cache.size >= 64) cache.delete(cache.keys().next().value!)
      cache.set(key, { result, expires: Date.now() + (result.status === 'ready' || result.status === 'empty' ? 60_000 : 5000) })
      return structuredClone(result)
    } finally { pending.delete(key) }
  }

  return async function getModels(options: { agent?: string; refresh?: boolean } = {}): Promise<CodingAgentModelsResponse> {
    if (options.agent !== undefined && !host.definitions.some(definition => definition.id === options.agent)) {
      throw Object.assign(new Error('Unknown coding agent'), { status: 400 })
    }
    const home = host.home()
    const inheritedEnv = await host.commandEnv()
    const env: NodeJS.ProcessEnv = { ...inheritedEnv, HOME: home,
      ...(process.platform === 'win32' ? { USERPROFILE: home } : {}),
      CODEX_HOME: inheritedEnv.CODEX_HOME || join(home, '.codex'),
      PI_CODING_AGENT_DIR: inheritedEnv.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent'),
      GROK_HOME: inheritedEnv.GROK_HOME || join(home, '.grok'),
      DSH_HOME: inheritedEnv.DSH_HOME || join(home, '.dsh'),
    }
    const definitions = host.definitions.filter(definition => !options.agent || definition.id === options.agent)
    return { agents: await Promise.all(definitions.map(definition => catalog(definition, env, options.refresh === true))) }
  }
}
