import { describe, expect, it } from 'vitest'
import {
  capabilityCatalogStatus,
  isOrcaRouterProvider,
  modelsForCapability,
  reconcileSelectedModel,
} from '../../packages/client/src/utils/modelCapabilities'

/**
 * Fixture: the capability buckets the server derives from a live
 * `GET /v1/models?capability=…` read. Only the image-input entry declares a
 * non-text modality.
 */
const LIVE_GROUP = {
  provider: 'orcarouter',
  models: ['openai/gpt-5.5'],
  capability_models: {
    chat: ['openai/gpt-5.5', 'deepseek/deepseek-v4-flash-vision-exp'],
    'chat-image': ['deepseek/deepseek-v4-flash-vision-exp'],
    'chat-audio': [],
    'chat-video': [],
    embedding: ['acme/embed-1'],
    image: ['acme/image-maker'],
    video: ['acme/video-maker'],
    rerank: ['acme/reranker'],
  },
  capability_catalog: { source: 'live' as const, degraded: false },
}

const DEGRADED_GROUP = {
  provider: 'orcarouter-oauth',
  models: ['openai/gpt-5.5', 'orcarouter/auto'],
  capability_models: {
    chat: ['openai/gpt-5.5', 'orcarouter/auto'],
    'chat-image': [],
    embedding: [],
    image: [],
    video: [],
    rerank: [],
  },
  capability_catalog: { source: 'seed' as const, degraded: true, reason: 'live catalog unavailable' },
}

const OTHER_PROVIDER = { provider: 'openrouter', models: ['anthropic/claude-opus-4.8'] }

describe('OrcaRouter provider identification', () => {
  it('recognises both first-class entry points only', () => {
    expect(isOrcaRouterProvider('orcarouter')).toBe(true)
    expect(isOrcaRouterProvider('orcarouter-oauth')).toBe(true)
    expect(isOrcaRouterProvider('ORCAROUTER')).toBe(true)
    expect(isOrcaRouterProvider('openrouter')).toBe(false)
    expect(isOrcaRouterProvider('custom:orcarouter')).toBe(false)
    expect(isOrcaRouterProvider(undefined)).toBe(false)
  })
})

describe('capability-filtered model options', () => {
  it('offers the API-derived chat list for OrcaRouter, not the seed', () => {
    expect(modelsForCapability(LIVE_GROUP, 'chat')).toEqual([
      'openai/gpt-5.5',
      'deepseek/deepseek-v4-flash-vision-exp',
    ])
  })

  it('filters image input to models that explicitly declare the modality', () => {
    expect(modelsForCapability(LIVE_GROUP, 'chat-image')).toEqual(['deepseek/deepseek-v4-flash-vision-exp'])
    expect(modelsForCapability(LIVE_GROUP, 'chat-image')).not.toContain('openai/gpt-5.5')
  })

  it('keeps every other capability on its own bucket', () => {
    expect(modelsForCapability(LIVE_GROUP, 'embedding')).toEqual(['acme/embed-1'])
    expect(modelsForCapability(LIVE_GROUP, 'image')).toEqual(['acme/image-maker'])
    expect(modelsForCapability(LIVE_GROUP, 'video')).toEqual(['acme/video-maker'])
    expect(modelsForCapability(LIVE_GROUP, 'rerank')).toEqual(['acme/reranker'])
    expect(modelsForCapability(LIVE_GROUP, 'chat-audio')).toEqual([])
    expect(modelsForCapability(LIVE_GROUP, 'chat-video')).toEqual([])
  })

  it('never leaks a non-text model into the text selector', () => {
    const chat = modelsForCapability(LIVE_GROUP, 'chat')
    for (const nonText of ['acme/image-maker', 'acme/video-maker', 'acme/reranker', 'acme/embed-1']) {
      expect(chat).not.toContain(nonText)
    }
  })

  it('leaves other providers on their existing model list', () => {
    expect(modelsForCapability(OTHER_PROVIDER, 'chat')).toEqual(['anthropic/claude-opus-4.8'])
    expect(modelsForCapability(OTHER_PROVIDER, 'chat-image')).toEqual(['anthropic/claude-opus-4.8'])
  })

  it('returns nothing rather than free text when a capability bucket is absent', () => {
    expect(modelsForCapability({ provider: 'orcarouter', models: [] }, 'chat')).toEqual([])
    expect(modelsForCapability(null, 'chat')).toEqual([])
    expect(modelsForCapability(undefined, 'chat')).toEqual([])
  })

  it('falls back to the labelled verified seed list when the catalog is degraded', () => {
    expect(modelsForCapability(DEGRADED_GROUP, 'chat')).toEqual(['openai/gpt-5.5', 'orcarouter/auto'])
    // A degraded catalog never invents a multimodal or non-text option.
    expect(modelsForCapability(DEGRADED_GROUP, 'chat-image')).toEqual([])
    expect(modelsForCapability(DEGRADED_GROUP, 'image')).toEqual([])
  })
})

describe('stale selection reconciliation', () => {
  it('clears a text model once an image attachment narrows the options', () => {
    const result = reconcileSelectedModel(LIVE_GROUP, 'openai/gpt-5.5', 'chat-image')
    expect(result.cleared).toBe(true)
    expect(result.model).toBe('deepseek/deepseek-v4-flash-vision-exp')
  })

  it('keeps a selection that is still compatible', () => {
    const result = reconcileSelectedModel(LIVE_GROUP, 'openai/gpt-5.5', 'chat')
    expect(result.cleared).toBe(false)
    expect(result.model).toBe('openai/gpt-5.5')
  })

  it('clears a model that vanished from the live catalog', () => {
    const result = reconcileSelectedModel(LIVE_GROUP, 'acme/retired-model', 'chat')
    expect(result.cleared).toBe(true)
    expect(result.model).toBe('openai/gpt-5.5')
  })

  it('clears rather than keeps a stored model when the list is empty', () => {
    const result = reconcileSelectedModel(DEGRADED_GROUP, 'openai/gpt-5.5', 'chat-image')
    expect(result.cleared).toBe(true)
    expect(result.model).toBe('')
  })

  it('picks a default when nothing was selected yet', () => {
    expect(reconcileSelectedModel(LIVE_GROUP, '', 'chat')).toEqual({ model: 'openai/gpt-5.5', cleared: false })
  })
})

describe('catalog status reporting', () => {
  it('reports live, degraded and unknown states', () => {
    expect(capabilityCatalogStatus(LIVE_GROUP)).toEqual({ degraded: false, source: 'live' })
    expect(capabilityCatalogStatus(DEGRADED_GROUP)).toEqual({
      degraded: true,
      source: 'seed',
      reason: 'live catalog unavailable',
    })
    expect(capabilityCatalogStatus(OTHER_PROVIDER)).toEqual({ degraded: false, source: 'unknown' })
    expect(capabilityCatalogStatus(null)).toEqual({ degraded: false, source: 'unknown' })
  })
})
