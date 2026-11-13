import { tmpdir } from 'os'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'

const realtimeStoreMock = vi.hoisted(() => ({
  getRealtimeModelSetting: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/repositories/realtime-settings-store', () => realtimeStoreMock)

import {
  callScannerOcr,
  SCANNER_DEFAULT_MODEL,
  SCANNER_IMAGE_MAX_CHARS,
  validateScannerInput,
  resolveScannerDashScopeKey,
} from '../../packages/server/src/modules/studio/services/scanner/ocr'

const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAr/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AB//Z'

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='

function makeOcrResponse(content: string | unknown[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        message: {
          content: Array.isArray(content) ? content : content,
        },
      }],
    }),
    text: async () => '',
  }
}

describe('scanner ocr input validation', () => {
  it('exposes a sensible default model', () => {
    expect(SCANNER_DEFAULT_MODEL).toBe('qwen-vl-ocr')
  })

  it('validates and rejects empty input', () => {
    expect(() => validateScannerInput([])).toThrow(/at least one page/)
  })

  it('rejects unsupported image MIME types', () => {
    expect(() => validateScannerInput([{ image: 'data:image/bmp;base64,AAAA' }])).toThrow(/unsupported/)
    expect(() => validateScannerInput([{ image: 'data:image/svg+xml;base64,AAAA' }])).toThrow(/unsupported/)
  })

  it('accepts raw base64 (no data: prefix) and treats it as jpeg', () => {
    const out = validateScannerInput([{ image: TINY_JPEG_BASE64 }])
    expect(out).toHaveLength(1)
    expect(out[0]!.image.startsWith('data:image/jpeg;base64,')).toBe(true)
  })

  it('accepts data URL with valid MIME', () => {
    const out = validateScannerInput([
      { image: `data:image/jpeg;base64,${TINY_JPEG_BASE64}` },
      { image: `data:image/png;base64,${TINY_PNG_BASE64}` },
    ])
    expect(out).toHaveLength(2)
  })

  it('rejects oversized images', () => {
    const big = 'A'.repeat(SCANNER_IMAGE_MAX_CHARS + 1)
    expect(() => validateScannerInput([{ image: `data:image/jpeg;base64,${big}` }])).toThrow(/too large/)
  })
})

describe('scanner ocr upstream call', () => {
  it('calls DashScope with Bearer auth and merges multi-page results', async () => {
    const fetchImpl = vi.fn(async () => makeOcrResponse([
      '第一页内容',
      { type: 'text', text: '---PAGE---\n第二页内容' },
    ]) as any)
    realtimeStoreMock.getRealtimeModelSetting.mockReturnValue(null)
    const result = await callScannerOcr(
      [{ image: `data:image/jpeg;base64,${TINY_JPEG_BASE64}` }, { image: `data:image/png;base64,${TINY_PNG_BASE64}` }],
      { apiKey: 'sk-test' },
      { fetchImpl: fetchImpl as any, apiKeyOverride: 'sk-test' },
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(String(url)).toContain('/chat/completions')
    const headers = (init as any).headers
    expect(headers.Authorization).toBe('Bearer sk-test')
    const body = JSON.parse((init as any).body)
    expect(body.model).toBe(SCANNER_DEFAULT_MODEL)
    expect(body.messages[0].content.some((p: any) => p.type === 'image_url')).toBe(true)
    expect(body.messages[0].content.some((p: any) => p.type === 'text')).toBe(true)
    expect(result.pages).toHaveLength(2)
    expect(result.pages[0]?.hasContent).toBe(true)
  })

  it('surfaces DashScope non-OK responses with an upstream error', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => 'invalid api key',
    }) as any)
    realtimeStoreMock.getRealtimeModelSetting.mockReturnValue(null)
    await expect(
      callScannerOcr(
        [{ image: `data:image/jpeg;base64,${TINY_JPEG_BASE64}` }],
        { apiKey: 'sk-test' },
        { fetchImpl: fetchImpl as any, apiKeyOverride: 'sk-test' },
      ),
    ).rejects.toMatchObject({ code: 'scanner_upstream_error' })
  })
})

describe('scanner ocr key resolution', () => {
  it('falls back to realtime-model setting when no inline apiKey is given', async () => {
    const fetchImpl = vi.fn(async () => makeOcrResponse('OCR result') as any)
    realtimeStoreMock.getRealtimeModelSetting.mockReturnValue({
      profile: 'default',
      settings: { model: 'qwen3.8-omni-flash-realtime', voice: 'Cherry' },
      secrets: { apiKey: 'sk-realtime' },
      createdAt: 0,
      updatedAt: 0,
    })
    const original = process.env.DASHSCOPE_API_KEY
    delete process.env.DASHSCOPE_API_KEY
    delete process.env.MEETING_ASR_DATA_DIR
    try {
      await callScannerOcr(
        [{ image: `data:image/jpeg;base64,${TINY_JPEG_BASE64}` }],
        { profile: 'default' },
        { fetchImpl: fetchImpl as any, profileOverride: 'default' },
      )
      const [, init] = fetchImpl.mock.calls[0]!
      const headers = (init as any).headers
      expect(headers.Authorization).toBe('Bearer sk-realtime')
      expect(realtimeStoreMock.getRealtimeModelSetting).toHaveBeenCalledWith('default', { includeSecrets: true })
    } finally {
      if (original !== undefined) process.env.DASHSCOPE_API_KEY = original
      realtimeStoreMock.getRealtimeModelSetting.mockReset()
    }
  })

  it('prefers inline apiKey over realtime-model setting', async () => {
    const fetchImpl = vi.fn(async () => makeOcrResponse('OCR result') as any)
    realtimeStoreMock.getRealtimeModelSetting.mockReturnValue({
      profile: 'default',
      settings: {},
      secrets: { apiKey: 'sk-realtime' },
      createdAt: 0,
      updatedAt: 0,
    })
    try {
      await callScannerOcr(
        [{ image: `data:image/jpeg;base64,${TINY_JPEG_BASE64}` }],
        { apiKey: 'sk-inline', profile: 'default' },
        { fetchImpl: fetchImpl as any, apiKeyOverride: 'sk-inline', profileOverride: 'default' },
      )
      const [, init] = fetchImpl.mock.calls[0]!
      expect((init as any).headers.Authorization).toBe('Bearer sk-inline')
      expect(realtimeStoreMock.getRealtimeModelSetting).not.toHaveBeenCalled()
    } finally {
      realtimeStoreMock.getRealtimeModelSetting.mockReset()
    }
  })

  it('reports missing api key when none of the sources have one', async () => {
    const fetchImpl = vi.fn(async () => makeOcrResponse('OCR result') as any)
    realtimeStoreMock.getRealtimeModelSetting.mockReturnValue(null)
    const original = process.env.DASHSCOPE_API_KEY
    const originalAsrDataDir = process.env.MEETING_ASR_DATA_DIR
    delete process.env.DASHSCOPE_API_KEY
    // 不只是删除 env：key 解析还会兜底到 MEETING_ASR_DATA_DIR（缺省时是
    // cwd/data/meeting-asr），开发机上那里常有真实 config.json/config.env。
    // 指向一个保证不存在的目录，三个来源全部为空，才能稳定走到 missing key 分支。
    process.env.MEETING_ASR_DATA_DIR = join(tmpdir(), `scanner-ocr-no-key-${Date.now()}`)
    try {
      await expect(
        callScannerOcr(
          [{ image: `data:image/jpeg;base64,${TINY_JPEG_BASE64}` }],
          { profile: 'default' },
          { fetchImpl: fetchImpl as any, profileOverride: 'default' },
        ),
      ).rejects.toMatchObject({ code: 'scanner_missing_api_key' })
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally {
      if (original !== undefined) process.env.DASHSCOPE_API_KEY = original
      if (originalAsrDataDir !== undefined) process.env.MEETING_ASR_DATA_DIR = originalAsrDataDir
      else delete process.env.MEETING_ASR_DATA_DIR
      realtimeStoreMock.getRealtimeModelSetting.mockReset()
    }
  })
})


it('recovers the shared ASR key from the canonical state alias when no data-dir override exists', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'scanner-state-key-'))
  const original = { ...process.env }
  realtimeStoreMock.getRealtimeModelSetting.mockReturnValue(null)
  delete process.env.MEETING_ASR_DATA_DIR
  delete process.env.HERMES_WEB_UI_HOME
  delete process.env.DASHSCOPE_API_KEY
  process.env.HERMES_WEBUI_STATE_DIR = stateDir
  mkdirSync(join(stateDir, 'meeting-asr'))
  writeFileSync(join(stateDir, 'meeting-asr', 'config.env'), 'DASHSCOPE_API_KEY=sk-state-alias-test\n')
  try {
    expect(await resolveScannerDashScopeKey(undefined, 'default')).toBe('sk-state-alias-test')
  } finally {
    for (const key of ['MEETING_ASR_DATA_DIR', 'HERMES_WEB_UI_HOME', 'HERMES_WEBUI_STATE_DIR', 'DASHSCOPE_API_KEY']) {
      if (original[key] === undefined) delete process.env[key]
      else process.env[key] = original[key]
    }
    realtimeStoreMock.getRealtimeModelSetting.mockReset()
    rmSync(stateDir, { recursive: true, force: true })
  }
})
