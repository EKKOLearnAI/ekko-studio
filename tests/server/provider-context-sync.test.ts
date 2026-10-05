import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

let db: DatabaseSync | null = null

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  vi.resetModules()
  vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
    getDb: () => db,
    getStoragePath: () => ':memory:',
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
  vi.resetModules()
  db?.close()
  db = null
})

async function loadProviderContext() {
  return import('../../packages/server/src/modules/studio/public/provider-context')
}

function contextRows() {
  return (db!.prepare('SELECT profile, provider, model, context_limit FROM model_context ORDER BY model').all() as Array<{
    profile: string
    provider: string
    model: string
    context_limit: number
  }>)
}

describe('provider advertised context sync', () => {
  it('auto-populates missing model_context rows without overwriting manual overrides', async () => {
    const { insertMissingProviderContextLengths, writeProviderContextLengths } = await loadProviderContext()

    // A manual override the user edited (the real editor write path) must survive auto-population.
    writeProviderContextLengths('default', 'custom:magpie', [['manual-model', 123_456]])

    const inserted = insertMissingProviderContextLengths('default', 'custom:magpie', {
      'manual-model': 999_999,
      'auto-model-a': 1_048_576,
      'auto-model-b': 262_144,
      'invalid-zero': 0,
      'invalid-negative': -5,
    })

    expect(inserted).toBe(2)
    const rows = contextRows()
    expect(rows).toEqual([
      { profile: 'default', provider: 'custom:magpie', model: 'auto-model-a', context_limit: 1_048_576 },
      { profile: 'default', provider: 'custom:magpie', model: 'auto-model-b', context_limit: 262_144 },
      { profile: 'default', provider: 'custom:magpie', model: 'manual-model', context_limit: 123_456 },
    ])

    // A second pass is a no-op: nothing is overwritten.
    expect(insertMissingProviderContextLengths('default', 'custom:magpie', { 'auto-model-a': 1 })).toBe(0)
    expect(contextRows().find(row => row.model === 'auto-model-a')?.context_limit).toBe(1_048_576)
  })

  it('keeps profiles isolated', async () => {
    const { insertMissingProviderContextLengths } = await loadProviderContext()
    insertMissingProviderContextLengths('default', 'custom:magpie', { 'model-a': 500_000 })
    insertMissingProviderContextLengths('research', 'custom:magpie', { 'model-a': 900_000 })
    const rows = contextRows()
    expect(rows).toEqual([
      { profile: 'default', provider: 'custom:magpie', model: 'model-a', context_limit: 500_000 },
      { profile: 'research', provider: 'custom:magpie', model: 'model-a', context_limit: 900_000 },
    ])
  })
})

describe('provider catalog descriptor fetch', () => {
  it('captures context_length / context_window / max_input_tokens and top_provider values', async () => {
    const { fetchProviderModelDescriptors, fetchProviderModels } = await import(
      '../../packages/server/src/modules/studio/public/provider-catalog'
    )
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      data: [
        { id: 'a', context_length: 1_048_576 },
        { id: 'b', context_window: 200_000 },
        { id: 'c', max_input_tokens: 128_000 },
        { id: 'd', top_provider: { context_length: 64_000 } },
        { id: 'e' },
      ],
    })))

    const descriptors = await fetchProviderModelDescriptors('http://127.0.0.1:3425/v1', 'magpie')
    expect(descriptors).toEqual([
      { id: 'a', contextLength: 1_048_576 },
      { id: 'b', contextLength: 200_000 },
      { id: 'c', contextLength: 128_000 },
      { id: 'd', contextLength: 64_000 },
      { id: 'e' },
    ])
    // fetchProviderModels keeps returning the sorted id list.
    expect(await fetchProviderModels('http://127.0.0.1:3425/v1', 'magpie')).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('applies the free-only filter to descriptors', async () => {
    const { fetchProviderModelDescriptors } = await import(
      '../../packages/server/src/modules/studio/public/provider-catalog'
    )
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      data: [
        { id: 'free-model:free', context_length: 300_000 },
        { id: 'paid-model', context_length: 500_000 },
      ],
    })))
    expect(await fetchProviderModelDescriptors('https://openrouter.ai/api/v1', 'k', true)).toEqual([
      { id: 'free-model:free', contextLength: 300_000 },
    ])
  })
})
