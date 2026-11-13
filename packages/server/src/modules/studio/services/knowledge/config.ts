/**
 * Knowledge plugin — typed configuration.
 *
 * All knowledge-plugin env reads go through this file. No other
 * module in the plugin reads `process.env` directly.
 *
 * Config is validated at load time; invalid combinations throw
 * `KnowledgeConfigError` immediately (fail-fast, don't half-init).
 *
 * API key resolution order:
 *   1. KNOWLEDGE_EMBED_API_KEY env var (explicit, takes precedence)
 *   2. $HERMES_WEB_UI_HOME/secrets/knowledge-embed.env file (DOTENV format)
 *   3. DASHSCOPE_API_KEY env var (shared with speech-to-text)
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { getWebUiHome } from '../../public/config'

// --- Error type -----------------------------------------------------------

export class KnowledgeConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KnowledgeConfigError'
  }
}

// --- Types ----------------------------------------------------------------

export interface KnowledgeConfig {
  /** Master enable/disable switch. */
  enabled: boolean
  /** Embedding provider — only 'tongyi' in v1. */
  embedProvider: string
  /** Model identifier. */
  embedModel: string
  /** Embedding dimension. */
  embedDim: number
  /** API key for the embedding provider. */
  embedApiKey: string
  /** API base URL. */
  embedApiBase: string
  /** Max texts per embedding request (Tongyi v3 hard limit: 10). */
  embedBatchSize: number
  /** Per-request timeout in ms. */
  embedTimeoutMs: number
  /** Max retry attempts on transient errors. */
  embedRetries: number
  /** Plain-text chunker window size in tokens. */
  chunkSize: number
  /** Plain-text chunker overlap in tokens. */
  chunkOverlap: number
  /** Markdown section overflow threshold in tokens. */
  chunkFallbackSize: number
  /** Max ingest queue depth. */
  queueDepth: number
  /** Supported file extensions (lowercased). */
  supportedExtensions: string[]
  /** Max file size in bytes for extraction (ARM protection). */
  maxFileSizeBytes: number
}

// --- Validation constants -------------------------------------------------

/** Dims supported by Tongyi text-embedding-v3. 1536 is v2-only. */
const VALID_DIMS = new Set([64, 128, 256, 512, 768, 1024])

/** Max Tongyi v3 batch size (hard limit). */
const MAX_BATCH_SIZE = 10

/** Default file extensions to index. */
const DEFAULT_EXTENSIONS = ['.md', '.txt', '.pdf', '.docx']

// --- Parsers --------------------------------------------------------------

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  const normalized = value.trim().toLowerCase()
  if (!normalized) return fallback
  return ['1', 'true', 'yes', 'on'].includes(normalized)
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (value == null || value.trim() === '') return fallback
  const parsed = Number.parseInt(value.trim(), 10)
  return Number.isInteger(parsed) ? parsed : fallback
}

// --- API key resolution ---------------------------------------------------

/**
 * Read a simple KEY=VALUE dotenv file. Only supports unquoted and
 * double-quoted values — sufficient for API keys.
 */
function parseDotenv(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx < 0) continue
    const key = trimmed.slice(0, eqIdx).trim()
    let val = trimmed.slice(eqIdx + 1).trim()
    // Strip matching quotes.
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    result[key] = val
  }
  return result
}

function resolveApiKey(env: Record<string, string | undefined>): string {
  // 1. Explicit env var.
  const explicit = env.KNOWLEDGE_EMBED_API_KEY?.trim()
  if (explicit) return explicit

  // 2. Secrets sidecar file.
  try {
    const secretsDir = join(getWebUiHome(env), 'secrets')
    const secretsFile = join(secretsDir, 'knowledge-embed.env')
    const content = readFileSync(secretsFile, 'utf-8')
    const parsed = parseDotenv(content)
    const fromFile = parsed.DASHSCOPE_API_KEY?.trim() || parsed.KNOWLEDGE_EMBED_API_KEY?.trim()
    if (fromFile) return fromFile
  } catch {
    // File doesn't exist — fall through to shared env var.
  }

  // 3. Shared DashScope key (used by speech-to-text).
  const shared = env.DASHSCOPE_API_KEY?.trim()
  if (shared) return shared

  return ''
}

// --- Config loader --------------------------------------------------------

export function loadKnowledgeConfig(
  env: Record<string, string | undefined> = process.env,
): KnowledgeConfig {
  const enabled = parseBoolean(env.KNOWLEDGE_ENABLED, false)

  const embedProvider = (env.KNOWLEDGE_EMBED_PROVIDER?.trim() || 'tongyi').toLowerCase()
  if (embedProvider !== 'tongyi') {
    throw new KnowledgeConfigError(
      `Unsupported embed provider '${embedProvider}'. Only 'tongyi' is supported in v1.`
    )
  }

  const embedModel = env.KNOWLEDGE_EMBED_MODEL?.trim() || 'text-embedding-v3'

  const embedDim = parseIntEnv(env.KNOWLEDGE_EMBED_DIM, 1024)
  if (!VALID_DIMS.has(embedDim)) {
    throw new KnowledgeConfigError(
      `KNOWLEDGE_EMBED_DIM=${embedDim} is not supported by text-embedding-v3. ` +
      `Valid dims: ${[...VALID_DIMS].sort((a, b) => a - b).join(', ')}. ` +
      `Note: 1536 is a v2-only dim.`
    )
  }

  const embedBatchSize = parseIntEnv(env.KNOWLEDGE_EMBED_BATCH_SIZE, 10)
  if (embedBatchSize < 1 || embedBatchSize > MAX_BATCH_SIZE) {
    throw new KnowledgeConfigError(
      `KNOWLEDGE_EMBED_BATCH_SIZE=${embedBatchSize} must be in 1..${MAX_BATCH_SIZE}.`
    )
  }

  const embedApiKey = resolveApiKey(env)
  if (enabled && !embedApiKey) {
    throw new KnowledgeConfigError(
      'Knowledge plugin is enabled but no embedding API key was found. ' +
      'Set KNOWLEDGE_EMBED_API_KEY, DASHSCOPE_API_KEY, or create ' +
      '$HERMES_WEB_UI_HOME/secrets/knowledge-embed.env.'
    )
  }

  const embedApiBase = env.KNOWLEDGE_EMBED_API_BASE?.trim() ||
    'https://dashscope.aliyuncs.com/api/v1'
  const embedTimeoutMs = parseIntEnv(env.KNOWLEDGE_EMBED_TIMEOUT_MS, 30_000)
  const embedRetries = parseIntEnv(env.KNOWLEDGE_EMBED_RETRIES, 3)

  const chunkSize = parseIntEnv(env.KNOWLEDGE_CHUNK_SIZE, 500)
  const chunkOverlap = parseIntEnv(env.KNOWLEDGE_CHUNK_OVERLAP, 50)
  const chunkFallbackSize = parseIntEnv(env.KNOWLEDGE_CHUNK_FALLBACK_SIZE, 800)

  if (chunkOverlap >= chunkSize / 2) {
    throw new KnowledgeConfigError(
      `KNOWLEDGE_CHUNK_OVERLAP (${chunkOverlap}) must be < KNOWLEDGE_CHUNK_SIZE / 2 (${chunkSize / 2}).`
    )
  }
  if (chunkFallbackSize < chunkSize) {
    throw new KnowledgeConfigError(
      `KNOWLEDGE_CHUNK_FALLBACK_SIZE (${chunkFallbackSize}) must be >= KNOWLEDGE_CHUNK_SIZE (${chunkSize}).`
    )
  }

  const queueDepth = parseIntEnv(env.KNOWLEDGE_QUEUE_DEPTH, 20)
  if (queueDepth < 1) {
    throw new KnowledgeConfigError(
      `KNOWLEDGE_QUEUE_DEPTH (${queueDepth}) must be >= 1.`
    )
  }

  const extsRaw = env.KNOWLEDGE_SUPPORTED_EXTENSIONS?.trim()
  const supportedExtensions = extsRaw
    ? extsRaw.split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_EXTENSIONS

  const maxFileSizeMb = parseIntEnv(env.KNOWLEDGE_MAX_FILE_SIZE_MB, 20)
  if (maxFileSizeMb < 1 || maxFileSizeMb > 500) {
    throw new KnowledgeConfigError(
      `KNOWLEDGE_MAX_FILE_SIZE_MB=${maxFileSizeMb} must be in 1..500.`
    )
  }
  const maxFileSizeBytes = maxFileSizeMb * 1024 * 1024

  return {
    enabled,
    embedProvider,
    embedModel,
    embedDim,
    embedApiKey,
    embedApiBase,
    embedBatchSize,
    embedTimeoutMs,
    embedRetries,
    chunkSize,
    chunkOverlap,
    chunkFallbackSize,
    queueDepth,
    supportedExtensions,
    maxFileSizeBytes,
  }
}
