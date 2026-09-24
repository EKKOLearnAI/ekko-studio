import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const originalWebUiHome = process.env.HERMES_WEB_UI_HOME
const originalWebuiStateDir = process.env.HERMES_WEBUI_STATE_DIR
const temporaryProfileDirs: string[] = []

afterEach(() => {
  vi.doUnmock('../../packages/server/src/modules/studio/public/profile-config')
  vi.doUnmock('../../packages/server/src/modules/studio/public/media-profile-config')
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.resetModules()
  if (originalWebUiHome === undefined) delete process.env.HERMES_WEB_UI_HOME
  else process.env.HERMES_WEB_UI_HOME = originalWebUiHome
  if (originalWebuiStateDir === undefined) delete process.env.HERMES_WEBUI_STATE_DIR
  else process.env.HERMES_WEBUI_STATE_DIR = originalWebuiStateDir
  for (const directory of temporaryProfileDirs.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('media controller', () => {
  it('lists and generates through the profile-scoped Hermes image provider registry', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hermes-native-image-'))
    temporaryProfileDirs.push(directory)
    const outputPath = join(directory, 'native.png')
    const listPrimaryImageProviders = vi.fn(async () => ({
      providers: [{
        name: 'openai', display_name: 'OpenAI Images', available: true, active: true,
        default_model: 'gpt-image-2', models: [{ id: 'gpt-image-2' }],
        capabilities: { modalities: ['text', 'image'] }, setup: {},
      }],
    }))
    const generatePrimaryImage = vi.fn(async () => ({
      provider: 'openai',
      result: {
        success: true,
        image: 'data:image/png;base64,aW1hZ2UtYnl0ZXM=',
        model: 'gpt-image-2',
      },
    }))
    vi.doMock('../../packages/server/src/modules/studio/public/profile-config', () => ({
      getActiveProfileName: () => 'default',
      getProfileDir: () => directory,
      listProfileNamesFromDisk: () => ['default'],
    }))
    vi.doMock('../../packages/server/src/modules/studio/public/media-profile-config', () => ({
      readConfigYamlForProfile: vi.fn(async () => ({
        auxiliary: { image_generation: { provider: 'image:openai', model: 'gpt-image-2', timeout: 45 } },
      })),
    }))
    vi.doMock('../../packages/server/src/modules/studio/public/chat-agent-runtime', () => ({
      listPrimaryImageProviders,
      generatePrimaryImage,
    }))
    const { apiKeyImageGenerate, getImageProviders } = await import('../../packages/server/src/modules/studio/controllers/media')
    const baseCtx: any = {
      state: { serverTokenAuth: true }, query: {}, request: {}, get: vi.fn(() => ''), status: 200, body: undefined,
    }
    await getImageProviders({ ...baseCtx })
    expect(listPrimaryImageProviders).toHaveBeenCalledWith('default')

    const ctx: any = {
      ...baseCtx,
      request: { body: { mode: 'text', prompt: 'make an icon', output_path: outputPath, size: '1024x1024' } },
    }
    await apiKeyImageGenerate(ctx)

    expect(ctx.body).toMatchObject({
      ok: true, provider: 'image:openai', model: 'gpt-image-2', output_paths: [outputPath], profile: 'default',
    })
    expect(generatePrimaryImage).toHaveBeenCalledWith('default', expect.objectContaining({
      provider: 'openai', prompt: 'make an icon', model: 'gpt-image-2', aspect_ratio: 'square',
    }), { timeoutMs: 45_000 })
  })

  it('uses Hermes Web UI media directory as the default generated video output path', async () => {
    process.env.HERMES_WEB_UI_HOME = '/tmp/hermes-web-ui-test-home'
    const { defaultImageOutputPath, defaultMediaOutputPath } = await import('../../packages/server/src/modules/studio/controllers/media')

    expect(defaultMediaOutputPath('req_123')).toBe(join('/tmp/hermes-web-ui-test-home', 'media', 'req_123.mp4'))
    expect(defaultMediaOutputPath('bad/request:id')).toBe(join('/tmp/hermes-web-ui-test-home', 'media', 'bad_request_id.mp4'))
    expect(defaultImageOutputPath('img_123')).toBe(join('/tmp/hermes-web-ui-test-home', 'media', 'img_123.png'))
    expect(defaultImageOutputPath('bad/request:id', 1)).toBe(join('/tmp/hermes-web-ui-test-home', 'media', 'bad_request_id-2.png'))
  })

  it('generates images through the requested configured custom provider', async () => {
    vi.stubEnv('AGNES_API_KEY', 'agnes-secret')
    vi.doMock('../../packages/server/src/modules/studio/public/profile-config', () => ({
      getActiveProfileName: () => 'default',
      getProfileDir: () => '/tmp/hermes-web-ui-test-profile',
      listProfileNamesFromDisk: () => ['default'],
    }))
    vi.doMock('../../packages/server/src/modules/studio/public/media-profile-config', () => ({
      readConfigYamlForProfile: vi.fn(async () => ({
        custom_providers: [{
          name: 'agnes',
          base_url: 'https://agnes.example/v1',
          api_key_env: 'AGNES_API_KEY',
          model: 'agnes-image-2.1-flash',
        }],
      })),
    }))
    const fetchMock = vi.fn(async () => new Response(
      'data: {"data":[{"b64_json":"aW1hZ2UtYnl0ZXM="}]}\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ))
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock as any
    try {
      const { apiKeyImageGenerate } = await import('../../packages/server/src/modules/studio/controllers/media')
      const ctx: any = {
        state: { serverTokenAuth: true },
        query: {},
        request: {
          body: {
            provider: 'agnes',
            mode: 'text',
            prompt: 'make an icon',
            output_path: '/tmp/hermes-web-ui-agnes-image.png',
          },
        },
        get: vi.fn(() => ''),
        status: 200,
        body: undefined,
      }

      await apiKeyImageGenerate(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body).toMatchObject({
        ok: true,
        mode: 'text',
        provider: 'agnes',
        base_url: 'https://agnes.example/v1',
        profile: 'default',
      })
      expect(fetchMock).toHaveBeenCalledWith(
        'https://agnes.example/v1/images/generations',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer agnes-secret',
            'Content-Type': 'application/json',
          }),
        }),
      )
      const requestInit = fetchMock.mock.calls[0][1] as RequestInit
      expect(JSON.parse(String(requestInit.body))).toMatchObject({
        model: 'gpt-image-2',
        prompt: 'make an icon',
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('takes the text-to-image route and timeout from the profile auxiliary settings', async () => {
    vi.stubEnv('STUDIO_IMG_KEY', 'studio-secret')
    vi.doMock('../../packages/server/src/modules/studio/public/profile-config', () => ({
      getActiveProfileName: () => 'default',
      getProfileDir: () => '/tmp/hermes-web-ui-test-profile',
      listProfileNamesFromDisk: () => ['default'],
    }))
    vi.doMock('../../packages/server/src/modules/studio/public/media-profile-config', () => ({
      readConfigYamlForProfile: vi.fn(async () => ({
        custom_providers: [{
          name: 'Studio Images',
          base_url: 'https://images.example/v1',
          api_key_env: 'STUDIO_IMG_KEY',
        }],
        auxiliary: {
          image_generation: { provider: 'custom:studio-images', model: 'seedream-4', timeout: 42 },
          image_edit: { provider: 'custom:studio-images', model: 'qwen-image-edit' },
        },
      })),
    }))
    const fetchMock = vi.fn(async () => new Response(
      'data: {"data":[{"b64_json":"aW1hZ2UtYnl0ZXM="}]}\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ))
    const originalFetch = globalThis.fetch
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal)
    globalThis.fetch = fetchMock as any
    try {
      const { apiKeyImageGenerate } = await import('../../packages/server/src/modules/studio/controllers/media')
      const ctx: any = {
        state: { serverTokenAuth: true },
        query: {},
        // No provider and no model in the request: everything comes from config.
        request: { body: { mode: 'text', prompt: 'make an icon', output_path: '/tmp/hermes-web-ui-configured.png' } },
        get: vi.fn(() => ''),
        status: 200,
        body: undefined,
      }

      await apiKeyImageGenerate(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body).toMatchObject({ ok: true, provider: 'Studio Images' })
      expect(String(fetchMock.mock.calls[0][0])).toBe('https://images.example/v1/images/generations')
      expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)))
        .toMatchObject({ model: 'seedream-4' })
      expect(timeoutSpy).toHaveBeenCalledWith(42_000)
    } finally {
      timeoutSpy.mockRestore()
      globalThis.fetch = originalFetch
    }
  })

  it('routes Studio image-to-image and multipart edits through their configured tasks', async () => {
    vi.stubEnv('GENERATION_IMG_KEY', 'generation-secret')
    vi.stubEnv('EDIT_IMG_KEY', 'edit-secret')
    vi.doMock('../../packages/server/src/modules/studio/public/profile-config', () => ({
      getActiveProfileName: () => 'default',
      getProfileDir: () => '/tmp/hermes-web-ui-test-profile',
      listProfileNamesFromDisk: () => ['default'],
    }))
    vi.doMock('../../packages/server/src/modules/studio/public/media-profile-config', () => ({
      readConfigYamlForProfile: vi.fn(async () => ({
        custom_providers: [
          {
            name: 'Generation Images',
            base_url: 'https://generation.example/v1',
            api_key_env: 'GENERATION_IMG_KEY',
          },
          {
            name: 'Edit Images',
            base_url: 'https://edit.example/v1',
            api_key_env: 'EDIT_IMG_KEY',
          },
        ],
        auxiliary: {
          image_generation: {
            provider: 'custom:generation-images',
            model: 'seedream-4',
            timeout: 41,
          },
          image_edit: {
            provider: 'custom:edit-images',
            model: 'qwen-image-edit',
            timeout: 73,
          },
        },
      })),
    }))
    const fetchMock = vi.fn(async () => new Response(
      'data: {"response":{"output":[{"result":"aW1hZ2UtYnl0ZXM="}]}}\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ))
    const originalFetch = globalThis.fetch
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal)
    globalThis.fetch = fetchMock as any
    try {
      const { apiKeyImageGenerate } = await import('../../packages/server/src/modules/studio/controllers/media')
      const ctx: any = {
        state: { serverTokenAuth: true },
        query: {},
        request: {
          body: {
            mode: 'image',
            prompt: 'redraw this icon',
            image_base64: 'aW1hZ2UtYnl0ZXM=',
            mime_type: 'image/png',
            output_path: '/tmp/hermes-web-ui-configured-edit.png',
          },
        },
        get: vi.fn(() => ''),
        status: 200,
        body: undefined,
      }

      await apiKeyImageGenerate(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body).toMatchObject({ ok: true, provider: 'Edit Images', mode: 'image' })
      expect(String(fetchMock.mock.calls[0][0])).toBe('https://edit.example/v1/responses')
      expect(fetchMock.mock.calls[0][1]).toMatchObject({
        headers: expect.objectContaining({ Authorization: 'Bearer edit-secret' }),
      })
      expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toMatchObject({
        model: 'qwen-image-edit',
        tools: [{ type: 'image_generation', model: 'seedream-4' }],
      })
      expect(timeoutSpy).toHaveBeenCalledWith(73_000)

      const editCtx: any = {
        state: { serverTokenAuth: true },
        query: {},
        request: {
          body: {
            mode: 'edit',
            prompt: 'change the background',
            image_base64: 'aW1hZ2UtYnl0ZXM=',
            mime_type: 'image/png',
            output_path: '/tmp/hermes-web-ui-configured-multipart-edit.png',
          },
        },
        get: vi.fn(() => ''),
        status: 200,
        body: undefined,
      }

      await apiKeyImageGenerate(editCtx)

      expect(editCtx.status).toBe(200)
      expect(editCtx.body).toMatchObject({ ok: true, provider: 'Generation Images', mode: 'edit' })
      expect(String(fetchMock.mock.calls[1][0])).toBe('https://generation.example/v1/images/edits')
      expect(fetchMock.mock.calls[1][1]).toMatchObject({
        headers: expect.objectContaining({ Authorization: 'Bearer generation-secret' }),
      })
      expect((fetchMock.mock.calls[1][1]?.body as FormData).get('model')).toBe('seedream-4')
      expect(timeoutSpy).toHaveBeenNthCalledWith(2, 41_000)
    } finally {
      timeoutSpy.mockRestore()
      globalThis.fetch = originalFetch
    }
  })

  it('reports the configured provider when it cannot be resolved', async () => {
    vi.doMock('../../packages/server/src/modules/studio/public/profile-config', () => ({
      getActiveProfileName: () => 'default',
      getProfileDir: () => '/tmp/hermes-web-ui-test-profile',
      listProfileNamesFromDisk: () => ['default'],
    }))
    vi.doMock('../../packages/server/src/modules/studio/public/media-profile-config', () => ({
      readConfigYamlForProfile: vi.fn(async () => ({
        custom_providers: [],
        auxiliary: {
          image_generation: { provider: 'custom:missing-images', model: 'seedream-4' },
        },
      })),
    }))
    const { apiKeyImageGenerate } = await import('../../packages/server/src/modules/studio/controllers/media')
    const ctx: any = {
      state: { serverTokenAuth: true },
      query: {},
      request: { body: { mode: 'text', prompt: 'make an icon' } },
      get: vi.fn(() => ''),
      status: 200,
      body: undefined,
    }

    await apiKeyImageGenerate(ctx)

    expect(ctx.status).toBe(401)
    expect(ctx.body).toEqual({
      error: 'Missing missing-images provider in profile "default" config.yaml.',
      code: 'missing_apikey_image_provider',
    })
  })

  it('lets the request override the configured image model', async () => {
    vi.stubEnv('STUDIO_IMG_KEY', 'studio-secret')
    vi.doMock('../../packages/server/src/modules/studio/public/profile-config', () => ({
      getActiveProfileName: () => 'default',
      getProfileDir: () => '/tmp/hermes-web-ui-test-profile',
      listProfileNamesFromDisk: () => ['default'],
    }))
    vi.doMock('../../packages/server/src/modules/studio/public/media-profile-config', () => ({
      readConfigYamlForProfile: vi.fn(async () => ({
        custom_providers: [{
          name: 'studio-images',
          base_url: 'https://images.example/v1',
          api_key_env: 'STUDIO_IMG_KEY',
        }],
        auxiliary: { image_generation: { provider: 'studio-images', model: 'seedream-4', timeout: 42 } },
      })),
    }))
    const fetchMock = vi.fn(async () => new Response(
      'data: {"data":[{"b64_json":"aW1hZ2UtYnl0ZXM="}]}\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ))
    const originalFetch = globalThis.fetch
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal)
    globalThis.fetch = fetchMock as any
    try {
      const { apiKeyImageGenerate } = await import('../../packages/server/src/modules/studio/controllers/media')
      const ctx: any = {
        state: { serverTokenAuth: true },
        query: {},
        request: {
          body: {
            mode: 'text',
            prompt: 'x',
            model: 'explicit-model',
            timeout_ms: 1_234,
            output_path: '/tmp/hermes-web-ui-override.png',
          },
        },
        get: vi.fn(() => ''),
        status: 200,
        body: undefined,
      }

      await apiKeyImageGenerate(ctx)

      expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)))
        .toMatchObject({ model: 'explicit-model' })
      expect(timeoutSpy).toHaveBeenCalledWith(1_234)
    } finally {
      timeoutSpy.mockRestore()
      globalThis.fetch = originalFetch
    }
  })

  it('forces response storage off for Studio image-to-image', async () => {
    vi.stubEnv('AGNES_API_KEY', 'agnes-secret')
    vi.doMock('../../packages/server/src/modules/studio/public/profile-config', () => ({
      getActiveProfileName: () => 'default',
      getProfileDir: () => '/tmp/hermes-web-ui-test-profile',
      listProfileNamesFromDisk: () => ['default'],
    }))
    vi.doMock('../../packages/server/src/modules/studio/public/media-profile-config', () => ({
      readConfigYamlForProfile: vi.fn(async () => ({
        custom_providers: [{
          name: 'agnes',
          base_url: 'https://agnes.example/v1',
          api_key_env: 'AGNES_API_KEY',
          model: 'agnes-image-2.1-flash',
        }],
      })),
    }))
    const fetchMock = vi.fn(async () => new Response(
      'data: {"response":{"output":[{"result":"aW1hZ2UtYnl0ZXM="}]} }\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    ))
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock as any
    try {
      const { apiKeyImageGenerate } = await import('../../packages/server/src/modules/studio/controllers/media')
      const ctx: any = {
        state: { serverTokenAuth: true },
        query: {},
        request: {
          body: {
            provider: 'agnes',
            mode: 'image',
            prompt: 'redraw this icon',
            image_base64: 'aW1hZ2UtYnl0ZXM=',
            mime_type: 'image/png',
            store: true,
            output_path: '/tmp/hermes-web-ui-agnes-image-edit.png',
          },
        },
        get: vi.fn(() => ''),
        status: 200,
        body: undefined,
      }

      await apiKeyImageGenerate(ctx)

      expect(ctx.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledWith(
        'https://agnes.example/v1/responses',
        expect.objectContaining({ method: 'POST' }),
      )
      const requestInit = fetchMock.mock.calls[0][1] as RequestInit
      expect(JSON.parse(String(requestInit.body))).toMatchObject({
        model: 'agnes-image-2.1-flash',
        store: false,
        stream: true,
        tools: [{
          type: 'image_generation',
          model: 'gpt-image-2',
        }],
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('rejects MiniMax image-to-video without credentials', async () => {
    vi.stubEnv('MINIMAX_API_KEY', '')
    vi.stubEnv('MINIMAX_CN_API_KEY', '')
    vi.doMock('../../packages/server/src/modules/studio/public/profile-config', () => ({
      getActiveProfileName: () => 'default',
      getProfileDir: () => '/tmp/hermes-web-ui-test-profile',
      listProfileNamesFromDisk: () => ['default'],
    }))
    vi.doMock('../../packages/server/src/modules/studio/public/media-profile-config', () => ({
      readConfigYamlForProfile: vi.fn(async () => ({ model: { provider: 'minimax' } })),
    }))
    const { miniMaxImageToVideo } = await import('../../packages/server/src/modules/studio/controllers/media')
    const ctx: any = {
      state: { serverTokenAuth: true },
      query: {},
      request: { body: { prompt: 'animate the scene', image_url: 'https://cdn.example.com/source.png' } },
      get: vi.fn(() => ''),
      status: 200,
      body: undefined,
    }

    await miniMaxImageToVideo(ctx)

    expect(ctx.status).toBe(401)
    expect(ctx.body).toMatchObject({
      code: 'missing_minimax_token',
      error: expect.stringContaining('MINIMAX_API_KEY'),
    })
  })

  it('generates image-to-video with the official MiniMax v1 workflow by default', async () => {
    vi.stubEnv('MINIMAX_API_KEY', 'minimax-test-key')
    vi.stubEnv('MINIMAX_CN_API_KEY', '')
    vi.doMock('../../packages/server/src/modules/studio/public/profile-config', () => ({
      getActiveProfileName: () => 'default',
      getProfileDir: () => '/tmp/hermes-web-ui-test-profile',
      listProfileNamesFromDisk: () => ['default'],
    }))
    vi.doMock('../../packages/server/src/modules/studio/public/media-profile-config', () => ({
      readConfigYamlForProfile: vi.fn(async () => ({ model: { provider: 'minimax' } })),
    }))
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const urlString = String(url)
      if (urlString.includes('/v1/query/video_generation')) {
        return new Response(JSON.stringify({ status: 'Success', file_id: 'file_default', base_resp: { status_code: 0 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (urlString.includes('/v1/files/retrieve')) {
        return new Response(JSON.stringify({ file: { download_url: 'https://cdn.example.com/video-default.mp4' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (urlString.includes('/v1/video_generation')) {
        return new Response(JSON.stringify({ task_id: 'task_default', base_resp: { status_code: 0 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(Buffer.from('mock-mp4-bytes'), { status: 200 })
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock as any
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((cb: () => void) => { cb(); return 0 }) as any
    try {
      const { miniMaxImageToVideo } = await import('../../packages/server/src/modules/studio/controllers/media')
      const ctx: any = {
        state: { serverTokenAuth: true },
        query: {},
        request: {
          body: {
            prompt: 'animate the water and clouds',
            image_url: 'https://cdn.example.com/source.png',
            output_path: '/tmp/hermes-web-ui-minimax-image-video.mp4',
          },
        },
        get: vi.fn(() => ''),
        status: 200,
        body: undefined,
      }

      await miniMaxImageToVideo(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body).toMatchObject({
        task_id: 'task_default',
        file_id: 'file_default',
        status: 'Success',
        model: 'MiniMax-Hailuo-2.3',
        api_version: 'v1',
        region: 'global_en',
        token_source: 'MINIMAX_API_KEY',
      })
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.minimax.io/v1/video_generation')
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
        model: 'MiniMax-Hailuo-2.3',
        first_frame_image: 'https://cdn.example.com/source.png',
        prompt: 'animate the water and clouds',
        duration: 6,
        resolution: '768P',
      })
      expect(fetchMock.mock.calls[1][0]).toBe('https://api.minimax.io/v1/query/video_generation?task_id=task_default')
      expect(fetchMock.mock.calls[2][0]).toBe('https://api.minimax.io/v1/files/retrieve?file_id=file_default')
    } finally {
      globalThis.fetch = originalFetch
      globalThis.setTimeout = originalSetTimeout
      vi.unstubAllEnvs()
    }
  })

  it('uses the selected profile MiniMax China API key and endpoint', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'hermes-web-ui-minimax-profile-'))
    temporaryProfileDirs.push(profileDir)
    writeFileSync(join(profileDir, '.env'), 'MINIMAX_CN_API_KEY="profile-cn-key"\n')
    vi.stubEnv('MINIMAX_API_KEY', '')
    vi.stubEnv('MINIMAX_CN_API_KEY', 'process-cn-key')
    vi.doMock('../../packages/server/src/modules/studio/public/profile-config', () => ({
      getActiveProfileName: () => 'default',
      getProfileDir: () => profileDir,
      listProfileNamesFromDisk: () => ['default'],
    }))
    vi.doMock('../../packages/server/src/modules/studio/public/media-profile-config', () => ({
      readConfigYamlForProfile: vi.fn(async () => ({ model: { provider: 'minimax-cn' } })),
    }))
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const urlString = String(url)
      if (urlString.includes('/v1/query/video_generation')) {
        return new Response(JSON.stringify({ status: 'Success', file_id: 'file_cn', base_resp: { status_code: 0 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (urlString.includes('/v1/files/retrieve')) {
        return new Response(JSON.stringify({ file: { download_url: 'https://cdn.example.com/video-cn.mp4' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (urlString.includes('/v1/video_generation')) {
        return new Response(JSON.stringify({ task_id: 'task_cn', base_resp: { status_code: 0 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(Buffer.from('mock-mp4-bytes'), { status: 200 })
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock as any
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((cb: () => void) => { cb(); return 0 }) as any
    try {
      const { miniMaxImageToVideo } = await import('../../packages/server/src/modules/studio/controllers/media')
      const ctx: any = {
        state: { serverTokenAuth: true },
        query: {},
        request: {
          body: {
            prompt: 'animate the portrait',
            image_url: 'https://cdn.example.com/portrait.png',
            aigc_watermark: true,
            output_path: '/tmp/hermes-web-ui-minimax-image-video-cn.mp4',
          },
        },
        get: vi.fn(() => ''),
        status: 200,
        body: undefined,
      }

      await miniMaxImageToVideo(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body).toMatchObject({
        task_id: 'task_cn',
        file_id: 'file_cn',
        model: 'MiniMax-Hailuo-2.3',
        api_version: 'v1',
        region: 'cn_zh',
        token_source: 'profile:MINIMAX_CN_API_KEY',
      })
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.minimaxi.com/v1/video_generation')
      expect(fetchMock.mock.calls[0][1]).toMatchObject({
        headers: expect.objectContaining({ Authorization: 'Bearer profile-cn-key' }),
      })
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
        aigc_watermark: true,
      })
    } finally {
      globalThis.fetch = originalFetch
      globalThis.setTimeout = originalSetTimeout
      vi.unstubAllEnvs()
    }
  })

  it('validates model-specific MiniMax duration and resolution options', async () => {
    vi.stubEnv('MINIMAX_API_KEY', 'minimax-test-key')
    vi.doMock('../../packages/server/src/modules/studio/public/profile-config', () => ({
      getActiveProfileName: () => 'default',
      getProfileDir: () => '/tmp/hermes-web-ui-test-profile',
      listProfileNamesFromDisk: () => ['default'],
    }))
    vi.doMock('../../packages/server/src/modules/studio/public/media-profile-config', () => ({
      readConfigYamlForProfile: vi.fn(async () => ({})),
    }))
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const urlString = String(url)
      if (urlString.includes('/v1/query/video_generation')) {
        return new Response(JSON.stringify({ status: 'Success', file_id: 'file_v1', base_resp: { status_code: 0 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (urlString.includes('/v1/files/retrieve')) {
        return new Response(JSON.stringify({ file: { download_url: 'https://cdn.example.com/video-v1.mp4' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (urlString.includes('/v1/video_generation')) {
        return new Response(JSON.stringify({ task_id: 'task_v1', base_resp: { status_code: 0 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(Buffer.from('mock-mp4-bytes'), { status: 200 })
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock as any
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((cb: () => void) => { cb(); return 0 }) as any
    try {
      const { miniMaxImageToVideo } = await import('../../packages/server/src/modules/studio/controllers/media')
      const ctx: any = {
        state: { serverTokenAuth: true },
        query: {},
        request: {
          body: {
            model: 'MiniMax-Hailuo-2.3',
            prompt: 'animate the portrait',
            image_url: 'https://cdn.example.com/portrait.png',
            duration: 10,
            resolution: '1080P',
          },
        },
        get: vi.fn(() => ''),
        status: 200,
        body: undefined,
      }

      await miniMaxImageToVideo(ctx)

      expect(ctx.status).toBe(400)
      expect(ctx.body).toMatchObject({
        error: 'MiniMax-Hailuo-2.3 does not support 1080P at 10 seconds',
      })
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = originalFetch
      globalThis.setTimeout = originalSetTimeout
      vi.unstubAllEnvs()
    }
  })
})
