import { Readable } from 'stream'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)
vi.mock('../../packages/server/src/modules/studio/services/voice/config-sync', () => ({
  syncVoiceConfigToHermesProfile: vi.fn(async () => ({ stt: 'synced', tts: 'unchanged' })),
}))

function jsonResponse(body: unknown, init: { status?: number; statusText?: string } = {}) {
  return {
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    async json() {
      return body
    },
    async text() {
      return JSON.stringify(body)
    },
  }
}

function textResponse(body: string, init: { status?: number; statusText?: string } = {}) {
  return {
    ok: (init.status ?? 500) >= 200 && (init.status ?? 500) < 300,
    status: init.status ?? 500,
    statusText: init.statusText ?? 'Error',
    async json() {
      return { error: body }
    },
    async text() {
      return body
    },
  }
}

function multipartBody(
  boundary: string,
  parts: Array<{
    name: string
    value: string | Buffer
    filename?: string
    filenameStar?: string
    contentType?: string
  }>,
): Buffer {
  const chunks: Buffer[] = []
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`))
    const filename = part.filename ? `; filename="${part.filename}"` : ''
    const filenameStar = part.filenameStar ? `; filename*=UTF-8''${part.filenameStar}` : ''
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"${filename}${filenameStar}\r\n`))
    if (part.contentType) {
      chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`))
    }
    chunks.push(Buffer.from('\r\n'))
    chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value))
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return Buffer.concat(chunks)
}

function getHeader(headers: RequestInit['headers'] | undefined, name: string): string | undefined {
  if (!headers) return undefined
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  if (Array.isArray(headers)) {
    const match = headers.find(([key]) => key.toLowerCase() === name.toLowerCase())
    return match?.[1]
  }

  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())
  return typeof match?.[1] === 'string' ? match[1] : undefined
}

async function waitForMockCalls(mock: { mock: { calls: unknown[] } }, count: number): Promise<void> {
  const startedAt = Date.now()
  while (mock.mock.calls.length < count && Date.now() - startedAt < 1000) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe('stt transcribe controller', () => {
  let db: any = null
  let tempDir: string | null = null

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))
  })

  afterEach(async () => {
    db?.close()
    db = null
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = null
    }
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.doUnmock('../../packages/server/src/modules/studio/public/config')
    vi.doUnmock('../../packages/server/src/modules/studio/services/voice/stt/audio-convert')
    vi.doUnmock('../../packages/server/src/modules/studio/services/voice/stt')
    vi.doUnmock('../../packages/server/src/modules/studio/public/mcu-voice')
    vi.resetModules()
  })

  async function initControllerAndStore() {
    const schemas = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    schemas.initAllHermesTables()
    return {
      ctrl: await import('../../packages/server/src/modules/studio/controllers/stt'),
      store: await import('../../packages/server/src/modules/studio/repositories/stt-settings-store'),
    }
  }

  function makeMultipartCtx(
    user: any | null,
    parts: Array<{ name: string; value: string | Buffer; filename?: string; filenameStar?: string; contentType?: string }>,
  ) {
    const boundary = 'stt-boundary'
    return {
      state: user ? { user } : {},
      request: {},
      req: Readable.from([multipartBody(boundary, parts)]),
      params: {},
      status: 200,
      body: null,
      set: vi.fn(),
      get: vi.fn((header: string) => header.toLowerCase() === 'content-type' ? `multipart/form-data; boundary=${boundary}` : ''),
    } as any
  }

  function makeJsonCtx(user: any | null, provider: string, body: unknown) {
    const headers: Record<string, string> = {}
    return {
      state: user ? { user } : {},
      request: { body },
      req: Readable.from([]),
      query: {},
      params: { provider },
      status: 200,
      body: null,
      set: vi.fn((name: string, value: string) => { headers[name] = value }),
      get: vi.fn(() => ''),
      headers,
    } as any
  }

  function makeRawAudioCtx(user: any | null, audio: Buffer, headers: Record<string, string> = {}) {
    const normalizedHeaders = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
    )
    return {
      state: user ? { user } : {},
      request: {},
      req: Readable.from([audio]),
      query: {},
      params: {},
      status: 200,
      body: null,
      set: vi.fn(),
      get: vi.fn((header: string) => normalizedHeaders[header.toLowerCase()] || ''),
    } as any
  }

  it('transcribes multipart audio using the stored secret and ignores client-supplied api keys', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ text: 'transcribed text' }))
    const { ctrl, store } = await initControllerAndStore()
    store.saveSttProviderSetting('default', 'openai', {
      settings: {
        model: 'gpt-4o-transcribe',
        language: 'en',
      },
      secrets: {
        apiKey: 'server-secret',
      },
    })

    const ctx = makeMultipartCtx(
      { id: 7, username: 'han', role: 'admin' },
      [
        { name: 'provider', value: 'openai' },
        { name: 'apiKey', value: 'attacker-secret' },
        { name: 'secrets', value: '{"apiKey":"body-secret"}' },
        { name: 'audio', value: Buffer.from('audio-data'), filename: 'speech.webm', contentType: 'audio/webm' },
      ],
    )

    await ctrl.transcribe(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toMatchObject({
      text: 'transcribed text',
      provider: 'openai',
      model: 'gpt-4o-transcribe',
      language: 'en',
    })
    expect(ctx.body.durationMs).toEqual(expect.any(Number))
    expect(JSON.stringify(ctx.body)).not.toContain('server-secret')
    expect(JSON.stringify(ctx.body)).not.toContain('attacker-secret')
    expect(JSON.stringify(ctx.body)).not.toContain('body-secret')

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [, init] = mockFetch.mock.calls[0] as [string | URL, RequestInit]
    expect(getHeader(init.headers, 'Authorization')).toBe('Bearer server-secret')
    expect(getHeader(init.headers, 'Authorization')).not.toContain('attacker-secret')
    expect(init.body).toBeInstanceOf(FormData)

    const form = init.body as FormData
    expect(form.get('model')).toBe('gpt-4o-transcribe')
    expect(form.get('language')).toBe('en')
  })

  it('masks stored api keys when listing STT settings', async () => {
    const { ctrl, store } = await initControllerAndStore()
    store.saveSttProviderSetting('default', 'openai', {
      settings: {
        model: 'gpt-4o-transcribe',
      },
      secrets: {
        apiKey: 'server-secret',
      },
    })

    const ctx = makeJsonCtx({ id: 7, username: 'han', role: 'admin' }, 'openai', undefined)
    await ctrl.listSettings(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toEqual({
      settings: [
        expect.objectContaining({
          provider: 'openai',
          secrets: { apiKey: '[stored]' },
        }),
      ],
      activeProvider: null,
    })
    expect(JSON.stringify(ctx.body)).not.toContain('server-secret')
  })

  it('reports profile STT as unconfigured when no active provider is saved', async () => {
    const { ctrl } = await initControllerAndStore()
    const ctx = makeJsonCtx({ id: 7, username: 'han', role: 'admin' }, '', undefined)
    ctx.query = { profile: 'default' }

    await ctrl.profileStatus(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toEqual({
      profile: 'default',
      configured: false,
      activeProvider: null,
      reason: 'active_stt_provider_missing',
    })
  })

  it('redirects to the bundled missing-STT prompt audio when profile STT is unconfigured', async () => {
    const { ctrl } = await initControllerAndStore()
    const ctx = makeJsonCtx({ id: 7, username: 'han', role: 'admin' }, '', undefined)

    await ctrl.missingProfileAudio(ctx)

    expect(ctx.status).toBe(302)
    expect(ctx.headers.Location).toBe('/api/studio/mcu/audio/missing-stt-24k.s16le.pcm')
    expect(ctx.headers['X-Hermes-STT-Configured']).toBe('false')
    expect(ctx.body).toEqual({
      url: '/api/studio/mcu/audio/missing-stt-24k.s16le.pcm',
    })
  })

  it('returns 204 from missing-STT prompt audio when profile STT is configured', async () => {
    const { ctrl, store } = await initControllerAndStore()
    store.saveSttProviderSetting('default', 'doubao', {
      settings: { model: 'volc.seedasr.auc' },
      secrets: { apiKey: 'server-secret' },
    })
    store.saveActiveSttProvider('default', 'doubao')
    const ctx = makeJsonCtx({ id: 7, username: 'han', role: 'admin' }, '', undefined)

    await ctrl.missingProfileAudio(ctx)

    expect(ctx.status).toBe(204)
    expect(ctx.body).toBeNull()
  })

  it('returns 400 when multipart audio is missing', async () => {
    const { ctrl, store } = await initControllerAndStore()
    store.saveSttProviderSetting('default', 'openai', {
      settings: { model: 'gpt-4o-transcribe' },
      secrets: { apiKey: 'server-secret' },
    })

    const ctx = makeMultipartCtx(
      { id: 7, username: 'han', role: 'admin' },
      [{ name: 'provider', value: 'openai' }],
    )

    await ctrl.transcribe(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'audio is required' })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns 400 for malformed multipart filename* without throwing', async () => {
    const { ctrl, store } = await initControllerAndStore()
    store.saveSttProviderSetting('default', 'openai', {
      settings: { model: 'gpt-4o-transcribe' },
      secrets: { apiKey: 'server-secret' },
    })

    const ctx = makeMultipartCtx(
      { id: 7, username: 'han', role: 'admin' },
      [
        { name: 'provider', value: 'openai' },
        {
          name: 'audio',
          value: Buffer.from('audio-data'),
          filenameStar: 'bad%ZZname.webm',
          contentType: 'audio/webm',
        },
      ],
    )

    await expect(ctrl.transcribe(ctx)).resolves.toBeUndefined()

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'Malformed multipart filename' })
    expect(JSON.stringify(ctx.body)).not.toContain('URIError')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns 400 when no saved STT settings exist for the requested provider', async () => {
    const { ctrl } = await initControllerAndStore()
    const ctx = makeMultipartCtx(
      { id: 7, username: 'han', role: 'admin' },
      [
        { name: 'provider', value: 'openai' },
        { name: 'audio', value: Buffer.from('audio-data'), filename: 'speech.webm', contentType: 'audio/webm' },
      ],
    )

    await ctrl.transcribe(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'STT settings are required for provider openai' })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns 400 for saved custom provider settings missing baseUrl', async () => {
    const { ctrl, store } = await initControllerAndStore()
    store.saveSttProviderSetting('default', 'custom', {
      settings: {
        model: 'whisper-1',
      },
      secrets: {
        apiKey: 'server-secret',
      },
    })

    const ctx = makeMultipartCtx(
      { id: 7, username: 'han', role: 'admin' },
      [
        { name: 'provider', value: 'custom' },
        { name: 'audio', value: Buffer.from('audio-data'), filename: 'speech.webm', contentType: 'audio/webm' },
      ],
    )

    await expect(ctrl.transcribe(ctx)).resolves.toBeUndefined()

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'Custom STT baseUrl is required' })
    expect(JSON.stringify(ctx.body)).not.toContain('server-secret')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('ignores client-supplied custom baseUrl, apiKey, and headers during transcription', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ text: 'custom transcript' }))
    const { ctrl, store } = await initControllerAndStore()
    store.saveSttProviderSetting('default', 'custom', {
      settings: {
        baseUrl: 'https://example.com/v1',
        model: 'whisper-1',
        language: 'fr',
      },
      secrets: {
        apiKey: 'server-secret',
      },
    })

    const ctx = makeMultipartCtx(
      { id: 7, username: 'han', role: 'admin' },
      [
        { name: 'provider', value: 'custom' },
        { name: 'baseUrl', value: 'http://127.0.0.1:8000/v1/audio/transcriptions' },
        { name: 'apiKey', value: 'attacker-secret' },
        { name: 'headers', value: '{"Authorization":"Bearer attacker-secret"}' },
        { name: 'settings', value: '{"baseUrl":"http://169.254.169.254/latest/meta-data"}' },
        { name: 'audio', value: Buffer.from('audio-data'), filename: 'speech.webm', contentType: 'audio/webm' },
      ],
    )

    await ctrl.transcribe(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toMatchObject({
      text: 'custom transcript',
      provider: 'custom',
      model: 'whisper-1',
      language: 'fr',
    })
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0] as [string | URL, RequestInit]
    expect(String(url)).toBe('https://example.com/v1/audio/transcriptions')
    expect(getHeader(init.headers, 'Authorization')).toBe('Bearer server-secret')
    expect(getHeader(init.headers, 'Authorization')).not.toContain('attacker-secret')
  })

  it('transcribes multipart audio with saved Doubao STT settings', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ...jsonResponse({}),
        headers: new Headers({ 'X-Api-Status-Code': '20000000' }),
      })
      .mockResolvedValueOnce({
        ...jsonResponse({ result: { text: '豆包识别文本' } }),
        headers: new Headers({ 'X-Api-Status-Code': '20000000' }),
      })
    const { ctrl, store } = await initControllerAndStore()
    store.saveSttProviderSetting('default', 'doubao', {
      settings: {
        baseUrl: 'https://openspeech.bytedance.com/api/v3/auc/bigmodel',
        model: 'volc.seedasr.auc',
      },
      secrets: {
        apiKey: 'server-secret',
      },
    })

    const ctx = makeMultipartCtx(
      { id: 7, username: 'han', role: 'admin' },
      [
        { name: 'provider', value: 'doubao' },
        { name: 'apiKey', value: 'attacker-secret' },
        { name: 'audio', value: Buffer.from('wav-audio'), filename: 'speech.wav', contentType: 'audio/wav' },
      ],
    )

    await ctrl.transcribe(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toMatchObject({
      text: '豆包识别文本',
      provider: 'doubao',
      model: 'volc.seedasr.auc',
    })
    expect(JSON.stringify(ctx.body)).not.toContain('server-secret')
    expect(JSON.stringify(ctx.body)).not.toContain('attacker-secret')
    expect(mockFetch).toHaveBeenCalledTimes(2)
    const [url, init] = mockFetch.mock.calls[0] as [string | URL, RequestInit]
    expect(String(url)).toBe('https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit')
    expect(getHeader(init.headers, 'X-Api-Key')).toBe('server-secret')
    expect(getHeader(init.headers, 'X-Api-Key')).not.toContain('attacker-secret')
  })

  it('passes MCU WAV audio to Doubao without ffmpeg normalization', async () => {
    const startMcuVoiceChatTurn = vi.fn()
    const audioConvertMock = {
      transcodeToWav: vi.fn(async (audio: Buffer) => ({
        audio: Buffer.concat([Buffer.from('converted:'), audio]),
        mimeType: 'audio/wav',
        fileName: 'audio.wav',
      })),
    }
    tempDir = mkdtempSync(join(tmpdir(), 'hermes-mcu-stt-test-'))
    vi.doMock('../../packages/server/src/modules/studio/public/config', () => ({
      config: { appHome: tempDir },
    }))
    vi.doMock('../../packages/server/src/modules/studio/services/voice/stt/audio-convert', () => audioConvertMock)
    vi.doMock('../../packages/server/src/modules/studio/public/mcu-voice', () => ({
      emitMcuVoiceEvent: vi.fn(),
      startMcuVoiceChatTurn,
    }))

    mockFetch
      .mockResolvedValueOnce({
        ...jsonResponse({}),
        headers: new Headers({ 'X-Api-Status-Code': '20000000' }),
      })
      .mockResolvedValueOnce({
        ...jsonResponse({ result: { text: '你好' } }),
        headers: new Headers({ 'X-Api-Status-Code': '20000000' }),
      })

    const { ctrl, store } = await initControllerAndStore()
    store.saveSttProviderSetting('default', 'doubao', {
      settings: {
        baseUrl: 'https://openspeech.bytedance.com/api/v3/auc/bigmodel',
        model: 'volc.seedasr.auc',
      },
      secrets: {
        apiKey: 'server-secret',
      },
    })
    store.saveActiveSttProvider('default', 'doubao')

    const wav = Buffer.from('raw-mcu-wav')
    const ctx = makeRawAudioCtx(
      { id: 7, username: 'han', role: 'admin' },
      wav,
      {
        'content-type': 'audio/wav',
        authorization: 'Bearer user-token',
        'x-hermes-mcu-interaction-id': 'voice-1',
        'x-hermes-mcu-device-id': 'device-1',
        'x-hermes-mcu-agent-runtime': 'hermes',
      },
    )

    await ctrl.mcuVoiceTurn(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toMatchObject({ ok: true, accepted: true, interactionId: 'voice-1' })
    await waitForMockCalls(mockFetch, 2)
    await waitForMockCalls(startMcuVoiceChatTurn, 1)
    expect(audioConvertMock.transcodeToWav).not.toHaveBeenCalled()
    expect(mockFetch).toHaveBeenCalledTimes(2)
    const [, init] = mockFetch.mock.calls[0] as [string | URL, RequestInit]
    expect(JSON.parse(String(init.body)).audio).toEqual({
      format: 'wav',
      data: wav.toString('base64'),
    })
    expect(startMcuVoiceChatTurn).toHaveBeenCalledWith({
      userToken: 'user-token',
      profile: 'default',
      interactionId: 'voice-1',
      transcript: '你好',
      clientId: 'device-1',
      agentRuntime: 'hermes',
    })
  })

  it('queues a separate prompt audio when MCU STT transcription fails after upload', async () => {
    const emitMcuEvent = vi.fn()
    vi.doMock('../../packages/server/src/modules/studio/public/mcu-voice', () => ({
      emitMcuVoiceEvent: emitMcuEvent,
      startMcuVoiceChatTurn: vi.fn(),
    }))
    vi.doMock('../../packages/server/src/modules/studio/services/voice/stt', async (importOriginal) => ({
      ...await importOriginal<typeof import('../../packages/server/src/modules/studio/services/voice/stt')>(),
      transcribeWithProvider: vi.fn(async () => {
        throw new Error('provider unavailable')
      }),
    }))

    const { ctrl, store } = await initControllerAndStore()
    store.saveSttProviderSetting('default', 'openai', {
      settings: {
        baseUrl: 'https://api.openai.com/v1/audio/transcriptions',
        model: 'gpt-4o-transcribe',
      },
      secrets: { apiKey: 'server-secret' },
    })
    store.saveActiveSttProvider('default', 'openai')

    const ctx = makeRawAudioCtx(
      { id: 7, username: 'han', role: 'admin' },
      Buffer.from('raw-mcu-wav'),
      {
        'content-type': 'audio/wav',
        authorization: 'Bearer user-token',
        'x-hermes-mcu-interaction-id': 'voice-1',
        'x-hermes-mcu-device-id': 'device-1',
      },
    )

    await ctrl.mcuVoiceTurn(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toMatchObject({ ok: true, accepted: true, interactionId: 'voice-1' })
    await waitForMockCalls(emitMcuEvent, 3)
    expect(emitMcuEvent).toHaveBeenCalledWith({
      type: 'audio.enqueue',
      interactionId: 'voice-1',
      segmentId: 'voice-1-stt-failed',
      text: '当前语音转文字失败了，请配置下语音转文字再使用哦',
      url: '/api/studio/mcu/audio/stt-failed-24k.s16le.pcm',
      mimeType: 'audio/x-pcm',
      format: 's16le',
      sampleRate: 24000,
      channels: 1,
    }, { clientId: 'device-1' })
  })

  it('silently completes an MCU turn when the provider detects no speech', async () => {
    const emitMcuEvent = vi.fn()
    vi.doMock('../../packages/server/src/modules/studio/public/mcu-voice', () => ({
      emitMcuVoiceEvent: emitMcuEvent,
      startMcuVoiceChatTurn: vi.fn(),
    }))
    vi.doMock('../../packages/server/src/modules/studio/services/voice/stt', async (importOriginal) => {
      const original = await importOriginal<typeof import('../../packages/server/src/modules/studio/services/voice/stt')>()
      const { SttNoSpeechDetectedError } = await import('../../packages/server/src/modules/studio/services/voice/stt/types')
      return {
        ...original,
        transcribeWithProvider: vi.fn(async () => {
          throw new SttNoSpeechDetectedError('no speech detected')
        }),
      }
    })

    const { ctrl, store } = await initControllerAndStore()
    store.saveSttProviderSetting('default', 'openai', {
      settings: {
        baseUrl: 'https://api.openai.com/v1/audio/transcriptions',
        model: 'gpt-4o-transcribe',
      },
      secrets: { apiKey: 'server-secret' },
    })
    store.saveActiveSttProvider('default', 'openai')

    const ctx = makeRawAudioCtx(
      { id: 7, username: 'han', role: 'admin' },
      Buffer.from('raw-mcu-wav'),
      {
        'content-type': 'audio/wav',
        authorization: 'Bearer user-token',
        'x-hermes-mcu-interaction-id': 'voice-1',
        'x-hermes-mcu-device-id': 'device-1',
      },
    )

    await ctrl.mcuVoiceTurn(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toMatchObject({ ok: true, accepted: true, interactionId: 'voice-1' })
    await waitForMockCalls(emitMcuEvent, 2)
    expect(emitMcuEvent).toHaveBeenCalledWith({
      type: 'interaction.status',
      interactionId: 'voice-1',
      status: 'completed',
      text: '',
    }, { clientId: 'device-1' })
    expect(emitMcuEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audio.enqueue' }),
      expect.anything(),
    )
    expect(emitMcuEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
      expect.anything(),
    )
  })

  it.each([
    'http://10.0.0.1:8000/v1/audio/transcriptions',
    'http://172.16.0.1:8000/v1/audio/transcriptions',
    'http://192.168.1.1:8000/v1/audio/transcriptions',
    'http://127.0.0.1:8000/v1/audio/transcriptions',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]:8000/v1/audio/transcriptions',
    'http://[fd00::1]:8000/v1/audio/transcriptions',
    'http://[fe90::1]:8000/v1/audio/transcriptions',
  ])('allows local or private custom baseUrl %s when saving settings', async (baseUrl) => {
    const { ctrl } = await initControllerAndStore()
    const ctx = makeJsonCtx(
      { id: 7, username: 'han', role: 'admin' },
      'custom',
      {
        settings: {
          baseUrl,
          model: 'whisper-1',
        },
        secrets: {
          apiKey: 'server-secret',
        },
      },
    )

    await ctrl.saveSettings(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.setting.settings.baseUrl).toContain(new URL(baseUrl).origin)
    expect(JSON.stringify(ctx.body)).not.toContain('server-secret')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns 502 without leaking secrets when the provider fails', async () => {
    mockFetch.mockResolvedValueOnce(textResponse('upstream rejected bearer server-secret', { status: 401, statusText: 'Unauthorized' }))
    const { ctrl, store } = await initControllerAndStore()
    store.saveSttProviderSetting('default', 'openai', {
      settings: { model: 'gpt-4o-transcribe' },
      secrets: { apiKey: 'server-secret' },
    })

    const ctx = makeMultipartCtx(
      { id: 7, username: 'han', role: 'admin' },
      [
        { name: 'provider', value: 'openai' },
        { name: 'audio', value: Buffer.from('audio-data'), filename: 'speech.webm', contentType: 'audio/webm' },
      ],
    )

    await ctrl.transcribe(ctx)

    expect(ctx.status).toBe(502)
    expect(ctx.body).toEqual({
      error: 'STT transcription failed: OpenAI-compatible STT returned HTTP 401: upstream rejected bearer [redacted]',
    })
    expect(JSON.stringify(ctx.body)).not.toContain('server-secret')
  })
})

describe('route registration ordering', () => {
  const ttsPublicMiddleware = async () => {}
  const ttsProtectedMiddleware = async () => {}
  const sttProtectedMiddleware = async () => {}
  let registerRoutes: typeof import('../../packages/server/src/bootstrap/routes')['registerRoutes']

  beforeAll(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.doUnmock('../../packages/server/src/bootstrap/routes')
    vi.doMock('../../packages/server/src/modules/studio/routes/tts', () => ({
      ttsRoutes: { routes: vi.fn(() => ttsPublicMiddleware) },
      ttsProtectedRoutes: { routes: vi.fn(() => ttsProtectedMiddleware) },
    }))
    vi.doMock('../../packages/server/src/modules/studio/routes/stt', () => ({
      sttProtectedRoutes: { routes: vi.fn(() => sttProtectedMiddleware) },
    }))

    // Loading the complete application graph is fixture setup. Keep the actual
    // registration and ordering assertions inside the unchanged test deadline.
    ;({ registerRoutes } = await import('../../packages/server/src/bootstrap/routes'))
  })

  it('mounts protected STT routes after requireAuth', () => {
    const use = vi.fn()
    const app = { use }
    const requireAuth = vi.fn(async () => {})

    registerRoutes(app as any, [requireAuth] as any)
    const mountedMiddleware = use.mock.calls.map(([middleware]) => middleware)

    expect(mountedMiddleware.indexOf(ttsPublicMiddleware)).toBeGreaterThanOrEqual(0)
    expect(mountedMiddleware.indexOf(requireAuth)).toBeGreaterThan(mountedMiddleware.indexOf(ttsPublicMiddleware))
    expect(mountedMiddleware.indexOf(sttProtectedMiddleware)).toBeGreaterThan(mountedMiddleware.indexOf(requireAuth))
    expect(mountedMiddleware.indexOf(sttProtectedMiddleware)).toBeGreaterThan(mountedMiddleware.indexOf(ttsProtectedMiddleware))
  })
})
