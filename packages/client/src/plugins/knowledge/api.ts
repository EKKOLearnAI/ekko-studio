/**
 * Knowledge plugin — API helpers.
 *
 * Thin typed wrappers around the shared `request()` helper.
 */

import { request } from '@/api/client'

// --- Types ----------------------------------------------------------------

export interface KnowledgeVault {
  id: number
  root_path: string
  name: string
  watch: number
  created_at: number
}

export interface KnowledgeDocument {
  id: number
  source_path: string
  source_hash: string
  vault_id: number
  mime_type: string
  size_bytes: number
  mtime: number
  indexed_at: number
  status: 'pending' | 'indexing' | 'indexed' | 'failed' | 'metadata_only'
  error: string | null
}

export interface KnowledgeHealth {
  vaults: { total: number; watching: number; offline: number }
  documents: { total: number; pending: number; indexed: number; failed: number; indexing: number; metadataOnly: number }
  chunks: { total: number }
  vecIndex: { vectorCount: number }
  ftsIndex: { sizeBytes: number; termCount: number }
  ingestion: { inFlight: number; queued: number; lastSuccessAt: number | null; lastFailureAt: number | null; lastError: string | null }
  embedder: { requestsLastHour: number; tokensLastHour: number; failuresLastHour: number; avgLatencyMs: number }
}

export interface SearchResult {
  chunkId: number
  documentId: number
  content: string
  distance: number
  vaultId: number
}

export interface SearchResponse {
  results: SearchResult[]
  totalCandidatesBeforeFilter: number
  warning?: string
}

export interface KnowledgeChunk {
  id: number
  document_id: number
  position: number
  content: string
  token_count: number
}

/** One search-hit record from the citation audit log. */
export interface KnowledgeReference {
  id: number
  document_id: number
  chunk_id: number
  // `(string & {})` keeps literal autocomplete for 'chat' / 'agent-tool'
  // without collapsing the union to plain string.
  source: 'chat' | 'agent-tool' | (string & {})
  session_id: string | null
  distance: number | null
  rank: number
  created_at: number
}

// --- API calls ------------------------------------------------------------

export async function listVaults(): Promise<{ vaults: KnowledgeVault[] }> {
  return request('/api/studio/knowledge/vaults')
}

export async function createVault(rootPath: string, name: string): Promise<{ vault: KnowledgeVault }> {
  return request('/api/studio/knowledge/vaults', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root_path: rootPath, name }),
  })
}

export async function deleteVault(id: number, cascade: boolean = false): Promise<void> {
  const qs = cascade ? '?cascade=true' : ''
  return request(`/api/studio/knowledge/vaults/${id}${qs}`, { method: 'DELETE' })
}

export async function listDocuments(filters?: { vaultId?: number; status?: string }): Promise<{ documents: KnowledgeDocument[] }> {
  const params = new URLSearchParams()
  if (filters?.vaultId) params.set('vault_id', String(filters.vaultId))
  if (filters?.status) params.set('status', filters.status)
  const qs = params.toString() ? `?${params.toString()}` : ''
  return request(`/api/studio/knowledge/documents${qs}`)
}

export async function getDocument(id: number): Promise<{ document: KnowledgeDocument }> {
  return request(`/api/studio/knowledge/documents/${id}`)
}

export async function deleteDocument(id: number): Promise<void> {
  return request(`/api/studio/knowledge/documents/${id}`, { method: 'DELETE' })
}

export async function searchKnowledge(body: {
  query: string
  vaultId?: number
  limit?: number
  hybrid?: boolean
  maxDistance?: number
  session_id?: string
}): Promise<SearchResponse> {
  return request('/api/studio/knowledge/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export interface KnowledgeSettings {
  /** Plugin master switch (KNOWLEDGE_ENABLED). */
  enabled: boolean
  /** Whether an embedding API key is resolvable. */
  keyConfigured: boolean
  /** Last 4 chars of the configured key — never the key itself. */
  keyHint?: string
  /** Whether the service is live (settings/vaults usable). */
  initialized: boolean
  model?: string
  dim?: number
}

export async function getSettings(): Promise<KnowledgeSettings> {
  return request('/api/studio/knowledge/settings')
}

export async function saveApiKey(apiKey: string): Promise<{ ok: boolean; initialized: boolean; enabled: boolean; reinitError?: string }> {
  return request('/api/studio/knowledge/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey }),
  })
}

export async function getHealth(): Promise<KnowledgeHealth> {
  return request('/api/studio/knowledge/health')
}

export async function fetchDocumentChunks(id: number): Promise<{ chunks: KnowledgeChunk[] }> {
  return request(`/api/studio/knowledge/documents/${id}/chunks`)
}

export async function fetchDocumentReferences(id: number, limit = 200): Promise<{ references: KnowledgeReference[] }> {
  return request(`/api/studio/knowledge/documents/${id}/references?limit=${limit}`)
}

/** Promote a metadata_only document to full indexing (async on the server). */
export async function indexDocument(id: number): Promise<{ documentId: number; status: string }> {
  return request(`/api/studio/knowledge/documents/${id}/index`, { method: 'POST' })
}

// --- Task-12: bootstrap, quota, directory browser, USB, task archive ----

export function bootstrapDefaultVaults(): Promise<{ created: string[]; skipped: string[]; failed: Array<{ path: string; reason: string }> }> {
  return request('/api/studio/knowledge/vaults/bootstrap-defaults', { method: 'POST' })
}

export interface KnowledgeQuota {
  totalBytes: number
  warn: boolean
  downgrade: boolean
  hardLimitReached: boolean
  vaultCount: number
  perVaultBytes: number
}

export function fetchQuota(): Promise<KnowledgeQuota> {
  return request('/api/studio/knowledge/quota')
}

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
  sizeBytes: number | null
  modifiedAt: number | null
  inAllowlist: boolean
}

export interface DirListing {
  path: string
  parent: string | null
  entries: DirEntry[]
}

export function listDirs(path: string, includeHidden = false): Promise<DirListing> {
  const qs = `path=${encodeURIComponent(path)}${includeHidden ? '&includeHidden=true' : ''}`
  return request(`/api/studio/knowledge/dirs?${qs}`)
}

export interface UsbDriveEntry {
  uuid: string
  label: string
  mountPath: string
  sizeBytes: number | null
  freeBytes: number | null
}

export interface HomeRootEntry {
  name: string
  path: string
  exists: boolean
}

export function listDrives(): Promise<{ usb: UsbDriveEntry[]; homeRoots: HomeRootEntry[] }> {
  return request('/api/studio/knowledge/drives')
}

export function scanUsbVolume(uuid: string): Promise<{ vaultId: number; status: string; documentsQueued: number; reused: boolean }> {
  return request(`/api/studio/knowledge/usb-volumes/${encodeURIComponent(uuid)}/scan`, { method: 'POST' })
}

