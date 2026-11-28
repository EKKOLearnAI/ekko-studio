import { describe, expect, it, vi } from 'vitest'
vi.mock('../../packages/server/src/modules/studio/services/voice/stt/index', () => ({ transcribeWithProvider: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/services/voice/stt/local-model-manager', () => ({ getLocalSttModelStatus: vi.fn(), transcribeWithLocalStt: vi.fn() }))
import { createMcuSttTranscriber } from '../../packages/server/src/modules/studio/services/voice/stt/mcu-fallback'
import { SttNoSpeechDetectedError, SttProviderHttpError, type SttTranscribeInput } from '../../packages/server/src/modules/studio/services/voice/stt/types'

const result = { text: '你好', provider: 'local' as const, model: 'local-model', durationMs: 20 }
const input = (): SttTranscribeInput => ({ provider: 'doubao', audio: Buffer.from('audio'), fileName: 'test.wav', mimeType: 'audio/wav', settings: { model: 'volc.seedasr.auc' }, secrets: { apiKey: 'private-test-key' } })
function setup() {
  let time = 1_000
  const primary = vi.fn().mockRejectedValue(new SttProviderHttpError('resource not granted', 403))
  const local = vi.fn().mockResolvedValue(result)
  const localReady = vi.fn().mockReturnValue(true)
  const api = createMcuSttTranscriber({ primary, local, localReady, now: () => time })
  return { api, primary, local, localReady, advance(ms: number) { time += ms } }
}
describe('MCU local speech fallback', () => {
  it('uses a validated local model after provider authorization failure without forwarding cloud secrets', async () => {
    const x = setup()
    expect(await x.api.transcribe(input(), 'default')).toMatchObject(result)
    expect(x.local).toHaveBeenCalledWith(expect.objectContaining({ provider: 'local', secrets: {}, settings: {} }))
    expect(JSON.stringify(x.api.status('default'))).not.toContain('private-test-key')
    expect(x.api.status('default')).toMatchObject({ active: true, sourceProvider: 'doubao', reason: 'provider_authentication' })
  })
  it('backs off a failed provider, then retries and clears the circuit after recovery', async () => {
    const x = setup()
    await x.api.transcribe(input(), 'default'); await x.api.transcribe(input(), 'default')
    expect(x.primary).toHaveBeenCalledTimes(1)
    x.advance(61_000); x.primary.mockResolvedValue({ ...result, provider: 'doubao' })
    expect(await x.api.transcribe(input(), 'default')).toMatchObject({ provider: 'doubao' })
    expect(x.primary).toHaveBeenCalledTimes(2)
    expect(x.api.status('default').active).toBe(false)
  })
  it('keeps circuit state separate for different profiles and credentials', async () => {
    const x = setup(); await x.api.transcribe(input(), 'default'); await x.api.transcribe(input(), 'other')
    const changed = input(); changed.secrets.apiKey = 'rotated-test-key'; await x.api.transcribe(changed, 'default')
    expect(x.primary).toHaveBeenCalledTimes(3)
  })
  it('shows recovered health immediately when a rotated credential succeeds', async () => {
    const x = setup(); await x.api.transcribe(input(), 'default')
    const changed = input(); changed.secrets.apiKey = 'working-rotated-key'
    x.primary.mockResolvedValue({ ...result, provider: 'doubao' })
    await x.api.transcribe(changed, 'default')
    expect(x.api.status('default')).toMatchObject({ active: false, reason: '', retryAt: 0 })
  })
  it.each([401, 429, 503])('handles a retryable provider failure with status %d', async status => {
    const x = setup(); x.primary.mockRejectedValue(new SttProviderHttpError('provider unavailable', status))
    expect(await x.api.transcribe(input(), 'default')).toMatchObject({ provider: 'local' })
    expect(x.local).toHaveBeenCalledTimes(1)
  })
  it('preserves the original failure when a local model is not validated', async () => {
    const x = setup(); x.localReady.mockReturnValue(false)
    await expect(x.api.transcribe(input(), 'default')).rejects.toBeInstanceOf(SttProviderHttpError)
    expect(x.local).not.toHaveBeenCalled()
  })
  it.each([new SttNoSpeechDetectedError('silence'), new SttProviderHttpError('invalid audio', 400), new Error('unexpected failure')])('does not reinterpret silence or malformed input as an authorization outage: %s', async failure => {
    const x = setup(); x.primary.mockRejectedValue(failure)
    await expect(x.api.transcribe(input(), 'default')).rejects.toBe(failure)
    expect(x.local).not.toHaveBeenCalled()
  })
  it('respects cancellation before any primary or fallback work', async () => {
    const x = setup(); const controller = new AbortController(); controller.abort()
    await expect(x.api.transcribe({ ...input(), signal: controller.signal }, 'default')).rejects.toMatchObject({ name: 'AbortError' })
    expect(x.primary).not.toHaveBeenCalled(); expect(x.local).not.toHaveBeenCalled()
  })
  it('does not deliver a late local result after cancellation', async () => {
    const x = setup(); const controller = new AbortController()
    x.local.mockImplementation(async () => { controller.abort(); return result })
    await expect(x.api.transcribe({ ...input(), signal: controller.signal }, 'default')).rejects.toMatchObject({ name: 'AbortError' })
  })
})
