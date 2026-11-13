/**
 * Knowledge plugin — cloud embedding client.
 *
 * v1 ships one provider: Tongyi `text-embedding-v3` (DashScope).
 * The provider interface is pluggable so OpenAI / DeepSeek / local
 * can be added as single-file additions.
 *
 * Batching: Tongyi v3 has a hard limit of 10 texts per request.
 * The embedder splits large inputs into batches and concatenates
 * the results, asserting length parity before returning.
 *
 * Retries: 3 attempts with 1s / 2s / 4s exponential backoff on
 * 5xx, 429, timeout, and network errors. After exhausting retries,
 * throws KnowledgeEmbedError with the provider's status code.
 *
 * Hard invariant: the embedder never silently returns fewer vectors
 * than input chunks. Length mismatch throws — silent mismatch
 * corrupts the vec0 index irrecoverably.
 */

// --- Public types --------------------------------------------------------

export class KnowledgeEmbedError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly providerMessage?: string,
  ) {
    super(message)
    this.name = 'KnowledgeEmbedError'
  }
}

export interface EmbedProvider {
  /** Embed a single batch of texts. Must return exactly texts.length vectors. */
  embedBatch(texts: string[]): Promise<Float32Array[]>
  /** Maximum texts per request. */
  readonly batchSize: number
}

export interface Embedder {
  embed(chunks: string[]): Promise<Float32Array[]>
}

export interface EmbedConfig {
  /** Provider name — only 'tongyi' is implemented in v1. */
  provider: string
  /** Model identifier. Default 'text-embedding-v3'. */
  model: string
  /** Embedding dimension. Default 1024. */
  dim: number
  /** API key — from env or secrets file. Never logged. */
  apiKey: string
  /** API base URL. */
  apiBase: string
  /** Max texts per request. Default 10 (Tongyi v3 hard limit). */
  batchSize: number
  /** Per-request timeout in ms. Default 30000. */
  timeoutMs: number
  /** Max retry attempts on transient errors. Default 3. */
  retries: number
}

export const DEFAULT_EMBED_CONFIG: EmbedConfig = {
  provider: 'tongyi',
  model: 'text-embedding-v3',
  dim: 1024,
  apiKey: '',
  apiBase: 'https://dashscope.aliyuncs.com/api/v1',
  batchSize: 10,
  timeoutMs: 30_000,
  retries: 3,
}

// --- HTTP helper ----------------------------------------------------------

interface HttpResponse {
  status: number
  body: unknown
  headers: Record<string, string>
}

/**
 * Minimal fetch wrapper with timeout. Uses the global `fetch`
 * (Node 18+). Injectable for testing via the provider's fetch override.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<HttpResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  // Merge caller signal with timeout signal.
  const combinedSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal

  try {
    const res = await fetch(url, { ...init, signal: combinedSignal })
    const headers: Record<string, string> = {}
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v
    })
    const body = await res.json().catch(() => null)
    return { status: res.status, body, headers }
  } finally {
    clearTimeout(timer)
  }
}

// --- Tongyi provider ------------------------------------------------------

export interface TongyiProviderDeps {
  /** Override fetch for testing (default: fetchWithTimeout). */
  fetch?: (url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal) => Promise<HttpResponse>
  /** Override sleep for testing (default: real setTimeout). */
  sleep?: (ms: number) => Promise<void>
}

export function createTongyiProvider(
  config: EmbedConfig,
  deps: TongyiProviderDeps = {},
): EmbedProvider {
  const doFetch = deps.fetch ?? fetchWithTimeout
  const doSleep = deps.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)))

  async function embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    if (texts.length > config.batchSize) {
      throw new KnowledgeEmbedError(
        `Tongyi batch size ${texts.length} exceeds limit ${config.batchSize}`,
      )
    }

    const url = `${config.apiBase}/services/embeddings`
    const body = JSON.stringify({
      model: config.model,
      input: { texts },
      parameters: { dimension: config.dim },
    })

    let lastError: KnowledgeEmbedError | null = null

    for (let attempt = 0; attempt <= config.retries; attempt++) {
      try {
        const res = await doFetch(
          url,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${config.apiKey}`,
            },
            body,
          },
          config.timeoutMs,
        )

        // 429 — rate limited. Respect Retry-After if present.
        if (res.status === 429) {
          const retryAfter = parseRetryAfter(res.headers['retry-after'])
          const waitMs = retryAfter ?? backoffDelay(attempt)
          if (attempt < config.retries) {
            await doSleep(waitMs)
            continue
          }
          throw new KnowledgeEmbedError(
            `Tongyi rate limited after ${config.retries + 1} attempts`,
            429,
            extractProviderMessage(res.body),
          )
        }

        // 5xx — server error, retry with backoff.
        if (res.status >= 500) {
          if (attempt < config.retries) {
            await doSleep(backoffDelay(attempt))
            continue
          }
          throw new KnowledgeEmbedError(
            `Tongyi server error ${res.status} after ${config.retries + 1} attempts`,
            res.status,
            extractProviderMessage(res.body),
          )
        }

        // 4xx (non-429) — client error, do not retry.
        if (res.status >= 400) {
          throw new KnowledgeEmbedError(
            `Tongyi client error ${res.status}`,
            res.status,
            extractProviderMessage(res.body),
          )
        }

        // Success — parse the response.
        return parseTongyiResponse(res.body, config.dim)
      } catch (err) {
        if (err instanceof KnowledgeEmbedError) {
          lastError = err
          // Client errors (4xx non-429) are not retried — rethrow immediately.
          if (err.statusCode !== undefined && err.statusCode >= 400 && err.statusCode < 500 && err.statusCode !== 429) {
            throw err
          }
          // Response parsing errors (no statusCode) are not retried —
          // they indicate a permanent format issue, not a transient failure.
          if (err.statusCode === undefined) {
            throw err
          }
          // If we've exhausted retries, throw.
          if (attempt >= config.retries) throw err
          // Otherwise wait and retry.
          await doSleep(backoffDelay(attempt))
        } else {
          // Network / timeout / abort — treat as transient.
          lastError = new KnowledgeEmbedError(
            `Embedding request failed: ${(err as Error).message}`,
          )
          if (attempt >= config.retries) throw lastError
          await doSleep(backoffDelay(attempt))
        }
      }
    }

    throw lastError ?? new KnowledgeEmbedError('Embedding request failed unexpectedly')
  }

  return { embedBatch, batchSize: config.batchSize }
}

function parseTongyiResponse(body: unknown, expectedDim: number): Float32Array[] {
  const obj = body as {
    output?: { embeddings?: Array<{ embedding?: unknown; text_index?: number }> }
    message?: string
  }
  const embeddings = obj?.output?.embeddings
  if (!Array.isArray(embeddings)) {
    throw new KnowledgeEmbedError(
      'Tongyi response missing output.embeddings',
      undefined,
      obj?.message,
    )
  }

  return embeddings.map((entry, i) => {
    const vec = entry.embedding
    if (!Array.isArray(vec)) {
      throw new KnowledgeEmbedError(
        `Tongyi embedding at index ${i} is not an array`,
      )
    }
    if (vec.length !== expectedDim) {
      throw new KnowledgeEmbedError(
        `Tongyi embedding dimension mismatch: expected ${expectedDim}, got ${vec.length}`,
      )
    }
    return new Float32Array(vec)
  })
}

function extractProviderMessage(body: unknown): string | undefined {
  if (body && typeof body === 'object') {
    const msg = (body as Record<string, unknown>).message
    if (typeof msg === 'string') return msg
  }
  return undefined
}

function parseRetryAfter(header: string | undefined): number | null {
  if (!header) return null
  const n = parseInt(header, 10)
  if (Number.isFinite(n) && n >= 0) return n * 1000
  return null
}

function backoffDelay(attempt: number): number {
  // attempt 0 → 1000, attempt 1 → 2000, attempt 2 → 4000
  return 1000 * Math.pow(2, attempt)
}

// --- Embedder (batch-and-retry wrapper) -----------------------------------

export function createEmbedder(
  provider: EmbedProvider,
): Embedder {
  return {
    async embed(chunks: string[]): Promise<Float32Array[]> {
      if (chunks.length === 0) return []

      const results: Float32Array[] = []
      for (let i = 0; i < chunks.length; i += provider.batchSize) {
        const batch = chunks.slice(i, i + provider.batchSize)
        const vectors = await provider.embedBatch(batch)
        if (vectors.length !== batch.length) {
          throw new KnowledgeEmbedError(
            `Provider returned ${vectors.length} vectors for batch of ${batch.length} ` +
            `(offset ${i}). This would corrupt the vec0 index.`,
          )
        }
        results.push(...vectors)
      }

      if (results.length !== chunks.length) {
        throw new KnowledgeEmbedError(
          `Embedding length mismatch: ${chunks.length} input chunks, ` +
          `${results.length} output vectors.`,
        )
      }

      return results
    },
  }
}
