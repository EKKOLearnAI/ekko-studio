import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ appHome: '' }))
const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

vi.mock('../../packages/server/src/modules/studio/public/config', () => ({
  config: {
    get appHome() {
      return state.appHome
    },
  },
}))

const tempDirs: string[] = []

function makeTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'hermes-local-stt-'))
  tempDirs.push(directory)
  return directory
}

function installSparseTestModel(manager: typeof import('../../packages/server/src/modules/studio/services/voice/stt/local-model-manager')) {
  const root = manager.localSttModelDirectory()
  mkdirSync(root, { recursive: true })
  const files: Record<string, number> = {
    'encoder-epoch-99-avg-1.int8.onnx': 181_895_032,
    'decoder-epoch-99-avg-1.onnx': 13_876_452,
    'joiner-epoch-99-avg-1.int8.onnx': 3_228_404,
    'tokens.txt': 56_317,
  }
  for (const [name, size] of Object.entries(files)) {
    const path = join(root, name)
    writeFileSync(path, '')
    truncateSync(path, size)
  }
  writeFileSync(join(root, 'model-manifest.json'), JSON.stringify({
    schema: 1,
    id: manager.LOCAL_STT_MODEL_ID,
    archiveSha256: manager.LOCAL_STT_MODEL_ARCHIVE_SHA256,
    validatedAt: new Date().toISOString(),
  }))
}

function createFakeModelProcess() {
  const child = new EventEmitter() as EventEmitter & {
    connected: boolean
    exitCode: number | null
    signalCode: NodeJS.Signals | null
    sent: any[]
    send: ReturnType<typeof vi.fn>
    kill: ReturnType<typeof vi.fn>
  }
  child.connected = true
  child.exitCode = null
  child.signalCode = null
  child.sent = []
  child.send = vi.fn((message: any, callback?: (error: Error | null) => void) => {
    child.sent.push(message)
    callback?.(null)
    queueMicrotask(() => {
      if (message.action === 'shutdown') {
        child.connected = false
        child.exitCode = 0
        child.emit('exit', 0, null)
        return
      }
      const text = message.action === 'stream-chunk'
        ? '增量文本'
        : message.action === 'stream-finish' || message.action === 'transcribe'
          ? '最终文本'
          : ''
      child.emit('message', { id: message.id, ok: true, text, durationMs: 3 })
    })
    return true
  })
  child.kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
    child.connected = false
    child.signalCode = signal
    queueMicrotask(() => child.emit('exit', null, signal))
    return true
  })
  return child
}

describe('local STT model manager', () => {
  beforeEach(() => {
    vi.resetModules()
    spawnMock.mockReset()
    state.appHome = makeTempDir()
  })

  afterEach(() => {
    vi.resetModules()
    for (const directory of tempDirs.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('reports the fixed model as unavailable until all files and the validation manifest exist', async () => {
    const manager = await import('../../packages/server/src/modules/studio/services/voice/stt/local-model-manager')
    expect(manager.getLocalSttModelStatus()).toMatchObject({
      id: manager.LOCAL_STT_MODEL_ID,
      installed: false,
      usable: false,
    })

    const root = manager.localSttModelDirectory()
    mkdirSync(root, { recursive: true })
    const files: Record<string, number> = {
      'encoder-epoch-99-avg-1.int8.onnx': 181_895_032,
      'decoder-epoch-99-avg-1.onnx': 13_876_452,
      'joiner-epoch-99-avg-1.int8.onnx': 3_228_404,
      'tokens.txt': 56_317,
    }
    for (const [name, size] of Object.entries(files)) {
      const path = join(root, name)
      writeFileSync(path, '')
      truncateSync(path, size)
    }

    expect(manager.getLocalSttModelStatus()).toMatchObject({
      installed: true,
      usable: false,
      validationError: expect.stringMatching(/runtime validation/i),
    })

    writeFileSync(join(root, 'model-manifest.json'), JSON.stringify({
      schema: 1,
      id: manager.LOCAL_STT_MODEL_ID,
      archiveSha256: manager.LOCAL_STT_MODEL_ARCHIVE_SHA256,
      validatedAt: new Date().toISOString(),
    }))

    expect(manager.getLocalSttModelStatus()).toMatchObject({
      installed: true,
      usable: true,
      validationError: '',
    })
  })

  it('resolves the Cloudflare and GitHub channels to the same pinned release asset', async () => {
    const manager = await import('../../packages/server/src/modules/studio/services/voice/stt/local-model-manager')
    expect(manager.localSttModelAssetUrl('cf')).toBe(
      `https://download.ekkolearnai.com/${manager.LOCAL_STT_MODEL_RELEASE_TAG}/${manager.LOCAL_STT_MODEL_ASSET_NAME}`,
    )
    expect(manager.localSttModelAssetUrl('github')).toBe(
      `https://github.com/EKKOLearnAI/ekko-studio/releases/download/${manager.LOCAL_STT_MODEL_RELEASE_TAG}/${manager.LOCAL_STT_MODEL_ASSET_NAME}`,
    )
  })

  it('wraps raw 16 kHz mono s16le PCM for local inference without ffmpeg', async () => {
    const manager = await import('../../packages/server/src/modules/studio/services/voice/stt/local-model-manager')
    const pcm = Buffer.from([0x00, 0x00, 0xff, 0x7f, 0x00, 0x80])

    const wav = manager.prepareLocalSttWav(pcm, 'audio/x-pcm; rate=16000; channels=1')

    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE')
    expect(wav.readUInt16LE(20)).toBe(1)
    expect(wav.readUInt16LE(22)).toBe(1)
    expect(wav.readUInt32LE(24)).toBe(16_000)
    expect(wav.readUInt16LE(34)).toBe(16)
    expect(wav.readUInt32LE(40)).toBe(pcm.length)
    expect(wav.subarray(44)).toEqual(pcm)
  })

  it('rejects compressed local STT input instead of depending on ffmpeg', async () => {
    const manager = await import('../../packages/server/src/modules/studio/services/voice/stt/local-model-manager')

    expect(() => manager.prepareLocalSttWav(Buffer.from('webm'), 'audio/webm')).toThrow(
      'Local STT accepts PCM WAV or raw 16 kHz mono s16le PCM audio',
    )
  })

  it('reuses one child recognizer across stream chunks and exits it during shutdown', async () => {
    const child = createFakeModelProcess()
    spawnMock.mockReturnValue(child)
    const manager = await import('../../packages/server/src/modules/studio/services/voice/stt/local-model-manager')
    installSparseTestModel(manager)
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(64)])

    const session = await manager.createLocalSttStreamSession('7:default')
    await expect(manager.pushLocalSttStreamAudio(
      session.sessionId,
      '7:default',
      wav,
      'audio/wav',
    )).resolves.toMatchObject({ text: '增量文本' })
    await expect(manager.finishLocalSttStreamSession(session.sessionId, '7:default'))
      .resolves.toMatchObject({ text: '最终文本' })

    const second = await manager.createLocalSttStreamSession('7:default')
    await manager.cancelLocalSttStreamSession(second.sessionId, '7:default')

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(child.sent.map(command => command.action)).toEqual([
      'stream-start',
      'stream-chunk',
      'stream-finish',
      'stream-start',
      'stream-cancel',
    ])

    await manager.shutdownLocalSttRuntime()
    expect(child.sent.at(-1)).toMatchObject({ action: 'shutdown' })
    expect(child.exitCode).toBe(0)
  })

  it('flushes enough trailing silence for the streaming recognizer to emit final words', async () => {
    spawnMock.mockReturnValue(createFakeModelProcess())
    const manager = await import('../../packages/server/src/modules/studio/services/voice/stt/local-model-manager')
    installSparseTestModel(manager)

    const session = await manager.createLocalSttStreamSession('7:default')
    await manager.finishLocalSttStreamSession(session.sessionId, '7:default')

    const childSource = spawnMock.mock.calls[0]?.[1]?.[2]
    expect(childSource).toContain('const FINAL_FLUSH_SILENCE_SECONDS = 0.8')
    expect(childSource).toContain('state.sampleRate * FINAL_FLUSH_SILENCE_SECONDS')
    await manager.shutdownLocalSttRuntime()
  })

  it('disables external wave buffers for Electron compatibility', async () => {
    spawnMock.mockReturnValue(createFakeModelProcess())
    const manager = await import('../../packages/server/src/modules/studio/services/voice/stt/local-model-manager')
    installSparseTestModel(manager)

    const session = await manager.createLocalSttStreamSession('7:default')
    await manager.finishLocalSttStreamSession(session.sessionId, '7:default')

    const childSource = spawnMock.mock.calls[0]?.[1]?.[2]
    expect(childSource).toContain('sherpa.readWave(audioPath, false)')
    await manager.shutdownLocalSttRuntime()
  })

  it('does not allow another profile owner to use a local stream session', async () => {
    spawnMock.mockReturnValue(createFakeModelProcess())
    const manager = await import('../../packages/server/src/modules/studio/services/voice/stt/local-model-manager')
    installSparseTestModel(manager)
    const session = await manager.createLocalSttStreamSession('7:default')

    await expect(manager.finishLocalSttStreamSession(session.sessionId, '8:default'))
      .rejects.toBeInstanceOf(manager.LocalSttStreamSessionError)
    await manager.cancelLocalSttStreamSession(session.sessionId, '7:default')
    await manager.shutdownLocalSttRuntime()
  })
})
