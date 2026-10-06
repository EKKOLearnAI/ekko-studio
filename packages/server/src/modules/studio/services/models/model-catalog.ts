import { createHash, randomUUID } from 'crypto'
import { readFileSync, statSync } from 'fs'
import { mkdir, rename, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { config } from '../../public/config'
import { logger } from '../../public/logging'

export const MODEL_CATALOG_URL = 'https://models.dev/api.json'
export const MODEL_CATALOG_PATH = join(config.appHome, 'models', 'models.dev.json')
const MAX_BYTES = 20 * 1024 * 1024
const RETRY_MS = 5 * 60_000

export interface CatalogModel {
  id?: string
  name?: string
  limit?: { context?: number; input?: number; output?: number }
  cost?: Record<string, unknown>
  reasoning?: boolean
  reasoning_options?: Array<{ type: string; values?: string[]; min?: number; max?: number }>
  attachment?: boolean
  modalities?: { input?: string[]; output?: string[] }
}
export type ModelCatalog = Record<string, { models?: Record<string, CatalogModel> }>
export interface ModelCatalogSnapshot {
  data: ModelCatalog
  fetchedAt: number
  version: string
}

function record(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function parseCatalog(raw: string, fetchedAt: number): ModelCatalogSnapshot {
  if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error('Model catalog is too large')
  const data: unknown = JSON.parse(raw)
  if (!record(data) || !Object.keys(data).length) throw new Error('Invalid model catalog')
  let modelCount = 0
  for (const provider of Object.values(data)) {
    if (!record(provider) || !record(provider.models)) throw new Error('Invalid catalog provider')
    for (const model of Object.values(provider.models)) {
      if (!record(model) || (model.limit !== undefined && !record(model.limit)) || (model.cost !== undefined && !record(model.cost))) {
        throw new Error('Invalid catalog model')
      }
      modelCount++
    }
  }
  if (!modelCount) throw new Error('Empty model catalog')
  return { data: data as ModelCatalog, fetchedAt, version: createHash('sha256').update(raw).digest('hex') }
}

/** One shared disk snapshot; a failed download never replaces the last good copy. */
export class ModelCatalogCache {
  private loaded = false
  private snapshot?: ModelCatalogSnapshot
  private pending?: Promise<ModelCatalogSnapshot | undefined>
  private attemptedAt = -Infinity

  constructor(
    private readonly path: string,
    private readonly fetcher: typeof fetch = (...args) => fetch(...args),
    private readonly now: () => number = Date.now,
  ) {}

  get(): ModelCatalogSnapshot | undefined {
    if (!this.loaded) {
      this.loaded = true
      try {
        const stat = statSync(this.path)
        if (stat.size <= MAX_BYTES) this.snapshot = parseCatalog(readFileSync(this.path, 'utf8'), stat.mtimeMs)
      } catch { /* A first launch may have no cache yet. */ }
    }
    return this.snapshot
  }

  refresh(force = false): Promise<ModelCatalogSnapshot | undefined> {
    if (this.pending) return this.pending
    this.get()
    if (!force && this.now() - this.attemptedAt < RETRY_MS) return Promise.resolve(this.snapshot)
    this.attemptedAt = this.now()
    this.pending = this.download().catch(err => {
      logger.warn({ err }, '[model-catalog] refresh failed; keeping local cache')
      return this.snapshot
    }).finally(() => { this.pending = undefined })
    return this.pending
  }

  private async download(): Promise<ModelCatalogSnapshot> {
    const response = await this.fetcher(MODEL_CATALOG_URL, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`Model catalog HTTP ${response.status}`)
    if (!response.body) throw new Error('Empty model catalog response')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_BYTES) throw new Error('Model catalog is too large')
        chunks.push(value)
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    const snapshot = parseCatalog(raw, this.now())
    const temporary = `${this.path}.${randomUUID()}.tmp`
    await mkdir(dirname(this.path), { recursive: true })
    try {
      await writeFile(temporary, raw)
      await rename(temporary, this.path)
    } finally { await rm(temporary, { force: true }).catch(() => {}) }
    this.snapshot = snapshot
    logger.info({ providers: Object.keys(snapshot.data).length }, '[model-catalog] local catalog updated')
    return snapshot
  }
}

const cache = new ModelCatalogCache(MODEL_CATALOG_PATH)
export const getModelCatalogSnapshot = () => cache.get()
export const getModelCatalog = () => cache.get()?.data || null
export const refreshModelCatalog = (force = false) => cache.refresh(force)
