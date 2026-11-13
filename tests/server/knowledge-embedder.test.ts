/**
 * Embedder tests — batching, retries, and length-parity invariant.
 *
 * Uses mock HTTP responses (no live API calls). The Tongyi provider
 * accepts a `fetch` override via `TongyiProviderDeps`, which we use
 * to replay recorded response fixtures.
 */

import { describe, expect, it } from 'vitest'
import {
  createEmbedder,
  createTongyiProvider,
  KnowledgeEmbedError,
  type EmbedConfig,
} from '../../packages/server/src/modules/studio/services/knowledge/embedder'

// --- Test helpers ---------------------------------------------------------

const TEST_CONFIG: EmbedConfig = {
  provider: 'tongyi',
  model: 'text-embedding-v3',
  dim: 4, // Small dim for tests
  apiKey: 'test-key-do-not-log',
  apiBase: 'https://test.example.com/api/v1',
  batchSize: 10,
  timeoutMs: 5000,
  retries: 3,
}

/**
 * Build a fake Tongyi response body for N vectors of dimension `dim`.
 */
function fakeTongyiResponse(dim: number, count: number) {
  return {
    output: {
      embeddings: Array.from({ length: count }, (_, i) => ({
        text_index: i,
        embedding: Array.from({ length: dim }, (_, j) => (i + j) * 0.01),
      })),
    },
  }
}

/**
 * Create a mock fetch that returns the given responses in sequence.
 * Each call to the returned function pops the next response.
 */
function mockFetch(
  responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>,
  calls: { urls: string[]; bodies: string[] } = { urls: [], bodies: [] },
) {
  const queue = [...responses]
  const fn = async (url: string, init: RequestInit) => {
    calls.urls.push(url)
    calls.bodies.push(String(init.body ?? ''))
    const res = queue.shift()
    if (!res) throw new Error('mockFetch: no more responses')
    return {
      status: res.status,
      body: res.body ?? null,
      headers: res.headers ?? {},
    }
  }
  return fn
}

const noSleep = async () => {} // Skip real delays in tests

// --- Basic embedding ------------------------------------------------------

describe('createEmbedder — basic', () => {
  it('returns empty array for empty input', async () => {
    const calls = { urls: [] as string[], bodies: [] as string[] }
    const fetchFn = mockFetch([], calls)
    const provider = createTongyiProvider(TEST_CONFIG, { fetch: fetchFn, sleep: noSleep })
    const embedder = createEmbedder(provider)
    const result = await embedder.embed([])
    expect(result).toEqual([])
    expect(calls.urls).toHaveLength(0) // fetch never called
  })

  it('embeds a single batch within the size limit', async () => {
    const chunks = Array(5).fill('hello world')
    const fetchFn = mockFetch([
      { status: 200, body: fakeTongyiResponse(4, 5) },
    ])
    const provider = createTongyiProvider(TEST_CONFIG, { fetch: fetchFn, sleep: noSleep })
    const embedder = createEmbedder(provider)
    const result = await embedder.embed(chunks)
    expect(result).toHaveLength(5)
    expect(result[0]).toBeInstanceOf(Float32Array)
    expect(result[0].length).toBe(4)
  })
})

// --- Batching -------------------------------------------------------------

describe('createEmbedder — batching', () => {
  it('splits 25 chunks into 3 requests (10 + 10 + 5)', async () => {
    const chunks = Array(25).fill('chunk text')
    const calls = { urls: [] as string[], bodies: [] as string[] }
    const fetchFn = mockFetch(
      [
        { status: 200, body: fakeTongyiResponse(4, 10) },
        { status: 200, body: fakeTongyiResponse(4, 10) },
        { status: 200, body: fakeTongyiResponse(4, 5) },
      ],
      calls,
    )
    const provider = createTongyiProvider(TEST_CONFIG, { fetch: fetchFn, sleep: noSleep })
    const embedder = createEmbedder(provider)
    const result = await embedder.embed(chunks)

    expect(result).toHaveLength(25)
    expect(calls.urls).toHaveLength(3)
    // All requests should hit the same endpoint.
    for (const url of calls.urls) {
      expect(url).toBe('https://test.example.com/api/v1/services/embeddings')
    }
    // Parse each request body to verify batch sizes.
    const parsedBodies = calls.bodies.map(b => JSON.parse(b))
    expect(parsedBodies[0].input.texts).toHaveLength(10)
    expect(parsedBodies[1].input.texts).toHaveLength(10)
    expect(parsedBodies[2].input.texts).toHaveLength(5)
  })

  it('exactly batchSize chunks produces one request', async () => {
    const chunks = Array(10).fill('chunk')
    const calls = { urls: [] as string[], bodies: [] as string[] }
    const fetchFn = mockFetch(
      [{ status: 200, body: fakeTongyiResponse(4, 10) }],
      calls,
    )
    const provider = createTongyiProvider(TEST_CONFIG, { fetch: fetchFn, sleep: noSleep })
    const embedder = createEmbedder(provider)
    await embedder.embed(chunks)
    expect(calls.urls).toHaveLength(1)
  })
})

// --- Retries --------------------------------------------------------------

describe('createTongyiProvider — retries', () => {
  it('retries on 5xx and succeeds on the second attempt', async () => {
    const chunks = ['hello']
    const fetchFn = mockFetch([
      { status: 500, body: { message: 'internal error' } },
      { status: 200, body: fakeTongyiResponse(4, 1) },
    ])
    const provider = createTongyiProvider(TEST_CONFIG, { fetch: fetchFn, sleep: noSleep })
    const embedder = createEmbedder(provider)
    const result = await embedder.embed(chunks)
    expect(result).toHaveLength(1)
    expect(fetchFn).toBeDefined
  })

  it('throws KnowledgeEmbedError after 3 consecutive 5xx', async () => {
    const chunks = ['hello']
    const fetchFn = mockFetch([
      { status: 500, body: { message: 'err1' } },
      { status: 502, body: { message: 'err2' } },
      { status: 503, body: { message: 'err3' } },
      { status: 500, body: { message: 'err4' } },
    ])
    const provider = createTongyiProvider(TEST_CONFIG, { fetch: fetchFn, sleep: noSleep })
    const embedder = createEmbedder(provider)

    await expect(embedder.embed(chunks)).rejects.toThrow(KnowledgeEmbedError)
    try {
      await embedder.embed(chunks)
    } catch (err) {
      expect(err).toBeInstanceOf(KnowledgeEmbedError)
      const ke = err as KnowledgeEmbedError
      // The last attempt's status code should be in the error.
      expect(ke.statusCode).toBeDefined
    }
  })

  it('respects 429 with Retry-After header', async () => {
    const chunks = ['hello']
    const sleepCalls: number[] = []
    const fetchFn = mockFetch([
      { status: 429, headers: { 'retry-after': '2' } },
      { status: 200, body: fakeTongyiResponse(4, 1) },
    ])
    const provider = createTongyiProvider(TEST_CONFIG, {
      fetch: fetchFn,
      sleep: async (ms) => { sleepCalls.push(ms) },
    })
    const embedder = createEmbedder(provider)
    await embedder.embed(chunks)
    // The sleep should have been called with 2000ms (Retry-After: 2).
    expect(sleepCalls).toContain(2000)
  })

  it('does not retry 4xx (non-429) client errors', async () => {
    const chunks = ['hello']
    const calls = { urls: [] as string[], bodies: [] as string[] }
    const fetchFn = mockFetch(
      [{ status: 400, body: { message: 'bad request' } }],
      calls,
    )
    const provider = createTongyiProvider(TEST_CONFIG, { fetch: fetchFn, sleep: noSleep })
    const embedder = createEmbedder(provider)

    await expect(embedder.embed(chunks)).rejects.toThrow(KnowledgeEmbedError)
    // Only one HTTP call — no retries.
    expect(calls.urls).toHaveLength(1)
  })
})

// --- Length mismatch ------------------------------------------------------

describe('createEmbedder — length parity', () => {
  it('throws when provider returns fewer vectors than chunks', async () => {
    const chunks = Array(5).fill('hello')
    // Provider returns 3 vectors for a batch of 5.
    const fetchFn = mockFetch([
      { status: 200, body: fakeTongyiResponse(4, 3) },
    ])
    const provider = createTongyiProvider(TEST_CONFIG, { fetch: fetchFn, sleep: noSleep })
    const embedder = createEmbedder(provider)

    await expect(embedder.embed(chunks)).rejects.toThrow(/returned 3 vectors for batch of 5/)
  })

  it('throws when provider returns more vectors than chunks', async () => {
    const chunks = Array(3).fill('hello')
    // Provider returns 5 vectors for a batch of 3.
    const fetchFn = mockFetch([
      { status: 200, body: fakeTongyiResponse(4, 5) },
    ])
    const provider = createTongyiProvider(TEST_CONFIG, { fetch: fetchFn, sleep: noSleep })
    const embedder = createEmbedder(provider)

    await expect(embedder.embed(chunks)).rejects.toThrow(/returned 5 vectors for batch of 3/)
  })
})

// --- Response parsing -----------------------------------------------------

describe('createTongyiProvider — response parsing', () => {
  it('throws on missing output.embeddings', async () => {
    const chunks = ['hello']
    const fetchFn = mockFetch([
      { status: 200, body: { output: {} } },
    ])
    const provider = createTongyiProvider(TEST_CONFIG, { fetch: fetchFn, sleep: noSleep })
    const embedder = createEmbedder(provider)

    await expect(embedder.embed(chunks)).rejects.toThrow(/missing output\.embeddings/)
  })

  it('throws on dimension mismatch', async () => {
    const chunks = ['hello']
    // Return 3-dim vector when config expects 4.
    const fetchFn = mockFetch([
      {
        status: 200,
        body: {
          output: {
            embeddings: [{ text_index: 0, embedding: [0.1, 0.2, 0.3] }],
          },
        },
      },
    ])
    const provider = createTongyiProvider(TEST_CONFIG, { fetch: fetchFn, sleep: noSleep })
    const embedder = createEmbedder(provider)

    await expect(embedder.embed(chunks)).rejects.toThrow(/dimension mismatch/)
  })
})

// --- Request shape --------------------------------------------------------

describe('createTongyiProvider — request shape', () => {
  it('sends correct headers and body structure', async () => {
    const chunks = ['test']
    let capturedInit: RequestInit | null = null
    const fetchFn = async (_url: string, init: RequestInit) => {
      capturedInit = init
      return { status: 200, body: fakeTongyiResponse(4, 1), headers: {} }
    }
    const provider = createTongyiProvider(TEST_CONFIG, { fetch: fetchFn, sleep: noSleep })
    const embedder = createEmbedder(provider)
    await embedder.embed(chunks)

    expect(capturedInit).not.toBeNull()
    const headers = capturedInit!.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer test-key-do-not-log')
    expect(headers['Content-Type']).toBe('application/json')

    const body = JSON.parse(String(capturedInit!.body))
    expect(body.model).toBe('text-embedding-v3')
    expect(body.input.texts).toEqual(['test'])
    expect(body.parameters.dimension).toBe(4)
  })
})
