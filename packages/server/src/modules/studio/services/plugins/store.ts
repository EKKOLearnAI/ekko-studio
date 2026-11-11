import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Json, PluginIdentity, PluginRecord, PluginStorage } from '../../contracts/plugins'
import { json } from './schema'
import { PluginError } from './errors'

export interface PluginState { revision: number; scope: 'global'; records: Record<string, PluginRecord> }
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
  read(): PluginState {
    const file = join(this.directory(), 'state.json')
    return readJson(file, () => ({ revision: 0, scope: 'global', records: {} }))
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
