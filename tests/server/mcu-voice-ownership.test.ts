import { Readable } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Context } from 'koa'
import { McuBindingError } from '../../packages/server/src/modules/studio/contracts/mcu-session-bindings'

const fixture = vi.hoisted(() => ({ reserve: vi.fn(), validate: vi.fn(), release: vi.fn(), start: vi.fn(), transcribe: vi.fn(), write: vi.fn(), emit: vi.fn() }))
vi.mock('fs/promises', async original => ({ ...await original<typeof import('fs/promises')>(), mkdir: vi.fn(), writeFile: fixture.write }))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ config: { appHome: '/unused-mcu-controller-test' } }))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../../packages/server/src/modules/studio/public/voice-settings', async original => ({ ...await original<object>(),
  getActiveSttProvider: () => 'doubao', isStoredSttProvider: () => true,
  getSttProviderSetting: () => ({ settings: {}, secrets: { apiKey: 'fixture-only' } }),
}))
vi.mock('../../packages/server/src/modules/studio/services/voice/stt', async original => ({ ...await original<object>(), transcribeWithProvider: fixture.transcribe }))
vi.mock('../../packages/server/src/modules/studio/services/voice/stt/mcu-fallback', () => ({ transcribeMcuWithFallback: fixture.transcribe, getMcuSttFallbackStatus: () => ({ ready: false }) }))
vi.mock('../../packages/server/src/modules/studio/public/mcu-voice', () => ({ startMcuVoiceChatTurn: fixture.start, emitMcuVoiceEvent: fixture.emit }))
vi.mock('../../packages/server/src/modules/studio/services/devices/mcu-session-bindings', () => ({
  reserveMcuVoiceRoute: fixture.reserve, validateMcuVoiceRoute: fixture.validate, releaseMcuVoiceRoute: fixture.release, validateMcuVoiceRecipient: fixture.validate,
}))
import { mcuVoiceTurn } from '../../packages/server/src/modules/studio/controllers/stt'

const route = { leaseId: 'verified-server-lease', clientId: 'own-client', profile: 'default', sessionId: 'selected-chat', signal: new AbortController().signal }
function context() {
  const headers: Record<string, string> = { authorization: 'Bearer fixture-app', 'x-hermes-profile': 'default',
    'x-hermes-mcu-device-id': 'own-client', 'x-hermes-mcu-interaction-id': 'voice-1', 'content-type': 'audio/wav' }
  return { status: 200, state: { user: { id: 1 }, profile: { name: 'default' } }, query: {}, req: Readable.from([Buffer.from('fixture WAV')]),
    get: (name: string) => headers[name.toLowerCase()] || '' } as unknown as Context
}
beforeEach(() => {
  fixture.reserve.mockResolvedValue(route); fixture.validate.mockResolvedValue(route)
  fixture.transcribe.mockResolvedValue({ text: 'hello', provider: 'doubao', model: 'fixture', durationMs: 1 })
  fixture.start.mockReturnValue(true); fixture.emit.mockReturnValue(true)
})
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs() })

it('rejects a cross-owner device header before consuming or transcribing the microphone upload', async () => {
  fixture.reserve.mockRejectedValue(new McuBindingError('MCU owner mismatch', 403, 'mcu_device_owner_mismatch'))
  const ctx = context()
  await mcuVoiceTurn(ctx)
  expect(ctx.status).toBe(403)
  expect(fixture.transcribe).not.toHaveBeenCalled()
  expect(fixture.start).not.toHaveBeenCalled()
  expect(fixture.write).not.toHaveBeenCalled()
})

it('keeps microphone audio ephemeral by default and hands the verified lease to the chat transport', async () => {
  vi.stubEnv('HERMES_MCU_STT_DEBUG_AUDIO', '')
  const ctx = context()
  await mcuVoiceTurn(ctx)
  await vi.waitFor(() => expect(fixture.start).toHaveBeenCalled())
  expect(fixture.write).not.toHaveBeenCalled()
  expect(fixture.validate).toHaveBeenCalledWith(route.leaseId, 'fixture-app')
  expect(fixture.start).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'own-client', routeLeaseId: route.leaseId }))
})

it('does not deliver a transcript or failure prompt to a replaced or revoked device after ASR', async () => {
  fixture.validate.mockRejectedValue(new McuBindingError('Device revoked', 403, 'mcu_device_owner_mismatch'))
  await mcuVoiceTurn(context())
  await vi.waitFor(() => expect(fixture.release).toHaveBeenCalled())
  expect(fixture.start).not.toHaveBeenCalled()
  expect(fixture.emit.mock.calls.filter(([event]) => event.status !== 'transcribing')).toEqual([])
})

it('releases an accepted lease on an ASR error, and saves diagnostics only with explicit opt-in', async () => {
  vi.stubEnv('HERMES_MCU_STT_DEBUG_AUDIO', '1')
  fixture.transcribe.mockRejectedValue(new Error('fixture provider unavailable'))
  await mcuVoiceTurn(context())
  await vi.waitFor(() => expect(fixture.release).toHaveBeenCalledWith(route.leaseId))
  expect(fixture.write).toHaveBeenCalledTimes(2)
  expect(fixture.start).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(fixture.emit.mock.calls.map(([event]) => event.status)).toEqual(['transcribing', 'failed', 'completed']))
  expect(fixture.emit.mock.calls.at(-1)![0]).toMatchObject({ outcome: 'failed', stop_reason: 'failed', interactionId: 'voice-1' })
})

it('aborts cancelled ASR without starting a chat or sending a failure prompt after the host settled its lease', async () => {
  const cancellation = new AbortController()
  const cancellableRoute = { ...route, signal: cancellation.signal }
  fixture.reserve.mockResolvedValue(cancellableRoute)
  fixture.validate.mockImplementation(async () => {
    if (cancellation.signal.aborted) throw new McuBindingError('Lease cancelled', 409, 'mcu_voice_lease_expired')
    return cancellableRoute
  })
  fixture.transcribe.mockImplementation(({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })
  }))
  await mcuVoiceTurn(context())
  cancellation.abort()
  await vi.waitFor(() => expect(fixture.release).toHaveBeenCalledWith(route.leaseId))
  expect(fixture.start).not.toHaveBeenCalled()
  expect(fixture.emit.mock.calls.filter(([event]) => event.status !== 'transcribing')).toEqual([])
})

it('does not restart transcription when the accepted lease was already cancelled during upload', async () => {
  const cancellation = new AbortController(); cancellation.abort()
  fixture.reserve.mockResolvedValue({ ...route, signal: cancellation.signal })
  await mcuVoiceTurn(context())
  await vi.waitFor(() => expect(fixture.release).toHaveBeenCalledWith(route.leaseId))
  expect(fixture.transcribe).not.toHaveBeenCalled()
  expect(fixture.emit).not.toHaveBeenCalled()
  expect(fixture.start).not.toHaveBeenCalled()
})

it('cancels a stalled microphone upload and retains its lease until the actual request stream exits', async () => {
  const cancellation = new AbortController()
  fixture.reserve.mockResolvedValue({ ...route, signal: cancellation.signal })
  let reading = false
  let finishDestroy: (() => void) | undefined
  const upload = new Readable({
    read() { if (!reading) { reading = true; this.push(Buffer.from('partial WAV')) } },
    destroy(error, callback) { finishDestroy = () => callback(error) },
  })
  const ctx = context(); ctx.req = upload as unknown as Context['req']
  let exited = false, requestError: unknown
  const pending = mcuVoiceTurn(ctx).then(() => { exited = true }, error => { exited = true; requestError = error })
  try {
    await vi.waitFor(() => expect(reading).toBe(true))
    cancellation.abort()
    await vi.waitFor(() => expect(upload.destroyed).toBe(true))
    expect(finishDestroy).toBeTypeOf('function')
    expect(exited).toBe(false)
    expect(fixture.release).not.toHaveBeenCalled()
    finishDestroy!()
    await pending
    expect(requestError).toBeUndefined()
    expect(ctx.status).toBe(499)
    expect(fixture.release).toHaveBeenCalledExactlyOnceWith(route.leaseId)
    expect(fixture.transcribe).not.toHaveBeenCalled()
    expect(fixture.start).not.toHaveBeenCalled()
    expect(fixture.emit).not.toHaveBeenCalled()
  } finally {
    if (!upload.destroyed) upload.destroy()
    finishDestroy?.()
    await pending
  }
})

it('retains an aborted ASR lease until the actual transcriber exits even when it does not immediately honor AbortSignal', async () => {
  const cancellation = new AbortController()
  fixture.reserve.mockResolvedValue({ ...route, signal: cancellation.signal })
  let exitTranscriber!: () => void
  fixture.transcribe.mockImplementation(() => new Promise((_resolve, reject) => {
    exitTranscriber = () => reject(new DOMException('cancelled', 'AbortError'))
  }))
  await mcuVoiceTurn(context())
  cancellation.abort()
  await Promise.resolve(); await Promise.resolve()
  expect(fixture.release).not.toHaveBeenCalled()
  expect(fixture.start).not.toHaveBeenCalled()
  expect(fixture.emit.mock.calls.filter(([event]) => event.status !== 'transcribing')).toEqual([])
  exitTranscriber()
  await vi.waitFor(() => expect(fixture.release).toHaveBeenCalledWith(route.leaseId))
  expect(fixture.start).not.toHaveBeenCalled()
  expect(fixture.emit.mock.calls.filter(([event]) => event.status !== 'transcribing')).toEqual([])
})

it('settles the accepted upload as failed when the native chat transport cannot take ownership after ASR', async () => {
  fixture.start.mockReturnValue(false)
  await mcuVoiceTurn(context())
  await vi.waitFor(() => expect(fixture.emit.mock.calls.at(-1)?.[0]).toMatchObject({ status: 'completed', outcome: 'failed' }))
  expect(fixture.release).toHaveBeenCalledWith(route.leaseId)
})
