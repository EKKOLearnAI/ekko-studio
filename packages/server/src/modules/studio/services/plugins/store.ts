import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Json, PluginIdentity, PluginRecord, PluginStorage } from '../../contracts/plugins'
import { json } from './schema'
import { PluginError } from './errors'

export interface PluginState { revision: number; scope: 'global'; records: Record<string, PluginRecord> }
interface LegacyPluginState { revision: number; userId: number; profile: string; records: Record<string, PluginRecord> }
export const scopeKey = (identity: Pick<PluginIdentity, 'userId' | 'profile'>) => createHash('sha256').update(JSON.stringify([identity.userId, identity.profile])).digest('hex')
export function readJson<T>(file: string, fallback: () => T): T {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback(); throw error }
}
export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomUUID()}.new`
  try { writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); renameSync(temp, file) }
  finally { rmSync(temp, { force: true }) }
}
export class PluginStore {
  constructor(readonly home: string) {}
  directory(): string { return join(this.home, 'global') }
  read(_identity?: Pick<PluginIdentity, 'userId' | 'profile'>): PluginState {
    const file = join(this.directory(), 'state.json')
    if (!existsSync(file)) this.migrate()
    return readJson(file, () => ({ revision: 0, scope: 'global', records: {} }))
  }
  private migrate(): void {
    const state: PluginState = { revision: 0, scope: 'global', records: {} }
    const sources: Array<{ scope: string; state: LegacyPluginState }> = []
    const skipped: string[] = [], duplicates: Array<{ id: string; retainedScope: string; skippedScope: string }> = []
    for (const scope of (existsSync(this.home) ? readdirSync(this.home) : []).filter(name => /^[a-f0-9]{64}$/.test(name)).sort()) {
      try {
        const value = readJson<LegacyPluginState | null>(join(this.home, scope, 'state.json'), () => null)
        if (!value) continue
        if (!Number.isSafeInteger(value.userId) || value.userId <= 0 || typeof value.profile !== 'string' || !value.records || !Number.isSafeInteger(value.revision)) throw new Error('Invalid legacy registry')
        sources.push({ scope, state: value })
        state.revision = Math.max(state.revision, value.revision + 1)
      } catch { skipped.push(scope) }
    }
    const candidates = sources.flatMap(source => Object.entries(source.state.records).map(([id, record]) => ({ ...source, id, record })))
      .sort((a, b) => b.record.installedAt - a.record.installedAt || a.scope.localeCompare(b.scope))
    const selected = new Map<string, string>()
    for (const candidate of candidates) {
      const { id, record, scope } = candidate
      if (selected.has(id)) { duplicates.push({ id, retainedScope: selected.get(id)!, skippedScope: scope }); continue }
      selected.set(id, scope)
      state.records[id] = { ...record, runtimeIdentity: { userId: candidate.state.userId, profile: candidate.state.profile } }
    }
    // Keep all original package directories and scoped data. A restart must never
    // resurrect an uninstalled plugin by importing the legacy registries again.
    writeJson(join(this.directory(), 'migration.json'), { migratedAt: Date.now(), sources: sources.map(source => source.scope), duplicates, skipped })
    writeJson(join(this.directory(), 'state.json'), state)
  }
  write(state: PluginState, expectedRevision: number): void {
    if (this.read().revision !== expectedRevision) throw new PluginError('Plugin settings changed; reload before saving', 'PLUGIN_REVISION', 409)
    writeJson(join(this.directory(), 'state.json'), { ...state, revision: expectedRevision + 1 })
  }
  storage(plugin: string, active: () => void, namespace: string[] = []): PluginStorage {
    active()
    if (!Array.isArray(namespace) || namespace.length > 16 || namespace.some(part => typeof part !== 'string' || !part || part.length > 256)) throw new PluginError('Invalid storage namespace')
    const segments = [...namespace]
    const key = createHash('sha256').update(JSON.stringify([plugin, segments])).digest('hex')
    const file = join(this.directory(), 'data', `${key}.json`)
    const check = (name: string) => {
      active()
      if (typeof name !== 'string' || !name || name.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(name)) throw new PluginError('Invalid storage key')
    }
    const read = () => readJson<Record<string, Json>>(file, () => ({}))
    return {
      namespace: (...parts) => this.storage(plugin, active, [...segments, ...parts]),
      async get<T extends Json>(name: string) { check(name); const data = read(); return (Object.hasOwn(data, name) ? structuredClone(data[name]) : undefined) as T | undefined },
      async set(name, value) { check(name); const data = read(); data[name] = json(value); json(data); writeJson(file, data) },
      async delete(name) { check(name); const data = read(); delete data[name]; writeJson(file, data) },
      async keys() { active(); return Object.keys(read()) },
    }
  }
}
