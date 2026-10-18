import { createHash, randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { basename, dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import * as tar from 'tar'
import { config } from '../../../public/config'
import { killOwnedProcessTree } from '../../../infrastructure/process-tree'
import { transcodeToPcmS16le } from './audio-convert'
import { SttNoSpeechDetectedError, type SttTranscribeInput, type SttTranscribeResult } from './types'

const DEFAULT_DOWNLOAD_BASE_URL = 'https://download.ekkolearnai.com'
const DEFAULT_GITHUB_REPO = 'EKKOLearnAI/ekko-studio'
const MODEL_MANIFEST_FILE = 'model-manifest.json'
const MODEL_SCHEMA = 1
const TRANSCRIBE_TIMEOUT_MS = 120_000
const LOCAL_STT_SAMPLE_RATE = 16_000
const DEFAULT_RUNTIME_IDLE_TIMEOUT_MS = 60_000
const DEFAULT_STREAM_SESSION_IDLE_TIMEOUT_MS = 120_000
const CHILD_EXIT_TIMEOUT_MS = 2_000

export const LOCAL_STT_MODEL_ID = 'sherpa-onnx-streaming-zipformer-bilingual-zh-en-int8-2023-02-20'
export const LOCAL_STT_MODEL_NAME = 'Streaming Zipformer Chinese-English INT8'
export const LOCAL_STT_MODEL_RELEASE_TAG = 'stt-zipformer-bilingual-zh-en-int8-2023-02-20'
export const LOCAL_STT_MODEL_ASSET_NAME = `${LOCAL_STT_MODEL_ID}.tar.gz`
export const LOCAL_STT_MODEL_ARCHIVE_SHA256 = '7d746b7c1c9762010ef2c61e9cc88ddb4e16a1b06f72a13a19a9c7a84e6c059e'
export const LOCAL_STT_MODEL_ARCHIVE_SIZE = 176_344_382
export const LOCAL_STT_MODEL_EXTRACTED_SIZE = 199_056_205

const REQUIRED_MODEL_FILES = {
  'encoder-epoch-99-avg-1.int8.onnx': 181_895_032,
  'decoder-epoch-99-avg-1.onnx': 13_876_452,
  'joiner-epoch-99-avg-1.int8.onnx': 3_228_404,
  'tokens.txt': 56_317,
} as const

export type LocalSttModelDownloadSource = 'cf' | 'github'
export type LocalSttModelJobStatus = 'queued' | 'running' | 'completed' | 'failed'
export type LocalSttModelJobStage = 'queued' | 'resolve' | 'download' | 'verify' | 'extract' | 'validate' | 'install' | 'completed' | 'failed'

export interface LocalSttModelDownloadJob {
  id: string
  source: LocalSttModelDownloadSource
  status: LocalSttModelJobStatus
  stage: LocalSttModelJobStage
  error: string
  percent?: number
  receivedBytes?: number
  totalBytes?: number
  createdAt: string
  updatedAt: string
}

export interface LocalSttModelStatus {
  id: string
  name: string
  languages: string[]
  archiveSize: number
  extractedSize: number
  installed: boolean
  usable: boolean
  validationError: string
  job: LocalSttModelDownloadJob | null
}

interface LocalSttModelManifest {
  schema: number
  id: string
  archiveSha256: string
  validatedAt: string
}

interface ModelProcessResult {
  id: string
  ok: boolean
  text?: string
  durationMs?: number
  error?: string
}

type ModelProcessAction = 'validate' | 'transcribe' | 'stream-start' | 'stream-chunk' | 'stream-finish' | 'stream-cancel'

interface ModelProcessCommand {
  id: string
  action: ModelProcessAction
  modelRoot?: string
  audioPath?: string
  sessionId?: string
}

interface ActiveModelCommand {
  id: string
  child: ChildProcess
  signal?: AbortSignal
  abort?: () => void
  timeout: ReturnType<typeof setTimeout>
  resolve: (result: ModelProcessResult) => void
  reject: (error: Error) => void
}

interface LocalSttStreamSession {
  ownerKey: string
  idleTimer: ReturnType<typeof setTimeout> | null
}

export interface LocalSttStreamResult {
  sessionId: string
  text: string
  model: string
  durationMs: number
}

export class LocalSttStreamSessionError extends Error {}

const jobs = new Map<string, LocalSttModelDownloadJob>()
const requireFromServer = createRequire(__filename)
const streamSessions = new Map<string, LocalSttStreamSession>()
let runtimeChild: ChildProcess | null = null
let activeModelCommand: ActiveModelCommand | null = null
let modelCommandQueue: Promise<void> = Promise.resolve()
let runtimeIdleTimer: ReturnType<typeof setTimeout> | null = null
let runtimeShuttingDown = false

const LOCAL_STT_CHILD_SOURCE = String.raw`
const path = require('node:path')
const streams = new Map()
const FINAL_FLUSH_SILENCE_SECONDS = 0.8
let sherpa = null
let recognizer = null
let recognizerRoot = ''

function modelConfig(root) {
  return new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(root, 'encoder-epoch-99-avg-1.int8.onnx'),
        decoder: path.join(root, 'decoder-epoch-99-avg-1.onnx'),
        joiner: path.join(root, 'joiner-epoch-99-avg-1.int8.onnx'),
      },
      tokens: path.join(root, 'tokens.txt'),
      numThreads: 2,
      provider: 'cpu',
      debug: 0,
      modelType: 'zipformer',
    },
    decodingMethod: 'greedy_search',
  })
}

function ensureRecognizer(root) {
  if (!recognizer) {
    sherpa = require(process.env.HERMES_LOCAL_STT_MODULE_PATH)
    recognizer = modelConfig(root)
    recognizerRoot = root
    return recognizer
  }
  if (root && recognizerRoot !== root) {
    throw new Error('Local STT runtime is already loaded with a different model directory')
  }
  return recognizer
}

function readWave(audioPath) {
  // Electron disallows Node-API external buffers, so request an owned
  // Float32Array that also remains compatible with the regular Node runtime.
  const wave = sherpa.readWave(audioPath, false)
  if (!wave || !wave.samples || !wave.samples.length || !wave.sampleRate) {
    throw new Error('Recorded audio is empty or is not a supported WAV file')
  }
  return wave
}

function decodeReady(stream) {
  while (recognizer.isReady(stream)) recognizer.decode(stream)
}

function resultText(stream) {
  const result = recognizer.getResult(stream)
  return typeof result.text === 'string' ? result.text.trim() : ''
}

function collectSoon() {
  if (typeof global.gc === 'function') setImmediate(() => global.gc())
}

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return
  if (message.action === 'shutdown') {
    streams.clear()
    if (process.connected) process.disconnect()
    process.exit(0)
    return
  }

  const startedAt = Date.now()
  try {
    const currentRecognizer = ensureRecognizer(message.modelRoot || recognizerRoot)
    let text = ''

    if (message.action === 'transcribe') {
      const wave = readWave(message.audioPath)
      const stream = currentRecognizer.createStream()
      stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples })
      stream.acceptWaveform({
        sampleRate: wave.sampleRate,
        samples: new Float32Array(Math.round(wave.sampleRate * FINAL_FLUSH_SILENCE_SECONDS)),
      })
      stream.inputFinished()
      decodeReady(stream)
      text = resultText(stream)
      collectSoon()
    } else if (message.action === 'stream-start') {
      if (!message.sessionId) throw new Error('Local STT stream session id is required')
      streams.set(message.sessionId, { stream: currentRecognizer.createStream(), sampleRate: 16000 })
    } else if (message.action === 'stream-chunk') {
      const state = streams.get(message.sessionId)
      if (!state) throw new Error('Local STT stream session is not active')
      const wave = readWave(message.audioPath)
      state.sampleRate = wave.sampleRate
      state.stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples })
      decodeReady(state.stream)
      text = resultText(state.stream)
    } else if (message.action === 'stream-finish') {
      const state = streams.get(message.sessionId)
      if (!state) throw new Error('Local STT stream session is not active')
      state.stream.acceptWaveform({
        sampleRate: state.sampleRate,
        samples: new Float32Array(Math.round(state.sampleRate * FINAL_FLUSH_SILENCE_SECONDS)),
      })
      state.stream.inputFinished()
      decodeReady(state.stream)
      text = resultText(state.stream)
      streams.delete(message.sessionId)
      collectSoon()
    } else if (message.action === 'stream-cancel') {
      streams.delete(message.sessionId)
      collectSoon()
    }

    if (process.connected) process.send({
      id: message.id,
      ok: true,
      text,
      durationMs: Date.now() - startedAt,
    })
  } catch (error) {
    if (process.connected) process.send({
      id: message.id,
      ok: false,
      error: error && error.message ? error.message : String(error),
    })
  }
})

process.on('disconnect', () => {
  streams.clear()
  process.exit(0)
})

process.on('uncaughtException', (error) => {
  if (process.connected) process.send({ id: '', ok: false, error: error && error.message ? error.message : String(error) })
  process.exit(1)
})

process.on('unhandledRejection', (error) => {
  if (process.connected) process.send({ id: '', ok: false, error: error && error.message ? error.message : String(error) })
  process.exit(1)
})
`

function modelStorageRoot(): string {
  return join(config.appHome, 'models')
}

export function localSttModelDirectory(): string {
  return join(modelStorageRoot(), LOCAL_STT_MODEL_ID)
}

function downloadBaseUrl(): string {
  return (process.env.HERMES_WEB_UI_DOWNLOAD_BASE_URL || DEFAULT_DOWNLOAD_BASE_URL).trim().replace(/\/$/, '')
}

export function localSttModelAssetUrl(source: LocalSttModelDownloadSource): string {
  if (source === 'github') {
    const repo = process.env.HERMES_WEB_UI_DOWNLOAD_GITHUB_REPO?.trim() || DEFAULT_GITHUB_REPO
    return `https://github.com/${repo}/releases/download/${encodeURIComponent(LOCAL_STT_MODEL_RELEASE_TAG)}/${encodeURIComponent(LOCAL_STT_MODEL_ASSET_NAME)}`
  }
  return `${downloadBaseUrl()}/${encodeURIComponent(LOCAL_STT_MODEL_RELEASE_TAG)}/${encodeURIComponent(LOCAL_STT_MODEL_ASSET_NAME)}`
}

function readManifest(root: string): LocalSttModelManifest | null {
  try {
    return JSON.parse(readFileSync(join(root, MODEL_MANIFEST_FILE), 'utf8')) as LocalSttModelManifest
  } catch {
    return null
  }
}

function inspectRequiredModelFiles(root: string): { installed: boolean; validationError: string } {
  const missing: string[] = []
  const invalid: string[] = []

  for (const [fileName, expectedSize] of Object.entries(REQUIRED_MODEL_FILES)) {
    const filePath = join(root, fileName)
    if (!existsSync(filePath)) {
      missing.push(fileName)
      continue
    }
    const fileStat = lstatSync(filePath)
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size !== expectedSize) {
      invalid.push(fileName)
    }
  }

  const installed = missing.length === 0
  if (!installed) {
    return { installed: false, validationError: '' }
  }
  if (invalid.length) {
    return { installed: true, validationError: `Invalid model files: ${invalid.join(', ')}` }
  }

  return { installed: true, validationError: '' }
}

function inspectModelDirectory(root: string): { installed: boolean; usable: boolean; validationError: string } {
  const files = inspectRequiredModelFiles(root)
  if (!files.installed || files.validationError) {
    return { ...files, usable: false }
  }

  const manifest = readManifest(root)
  if (
    manifest?.schema !== MODEL_SCHEMA ||
    manifest.id !== LOCAL_STT_MODEL_ID ||
    manifest.archiveSha256 !== LOCAL_STT_MODEL_ARCHIVE_SHA256
  ) {
    return { installed: true, usable: false, validationError: 'The local STT model has not passed runtime validation' }
  }

  return { installed: true, usable: true, validationError: '' }
}

function latestJob(): LocalSttModelDownloadJob | null {
  const job = Array.from(jobs.values()).sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
  return job ? { ...job } : null
}

export function getLocalSttModelStatus(): LocalSttModelStatus {
  const state = inspectModelDirectory(localSttModelDirectory())
  return {
    id: LOCAL_STT_MODEL_ID,
    name: LOCAL_STT_MODEL_NAME,
    languages: ['zh', 'en'],
    archiveSize: LOCAL_STT_MODEL_ARCHIVE_SIZE,
    extractedSize: LOCAL_STT_MODEL_EXTRACTED_SIZE,
    ...state,
    job: latestJob(),
  }
}

export function isLocalSttModelUsable(): boolean {
  return getLocalSttModelStatus().usable
}

function updateJob(job: LocalSttModelDownloadJob, patch: Partial<LocalSttModelDownloadJob>): void {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() })
}

function downloadFile(url: string, target: string, job: LocalSttModelDownloadJob, redirects = 5): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const parsed = new URL(url)
    const getter = parsed.protocol === 'http:' ? httpGet : httpsGet
    const request = getter(parsed, response => {
      const status = response.statusCode || 0
      const location = response.headers.location
      if (status >= 300 && status < 400 && location && redirects > 0) {
        response.resume()
        downloadFile(new URL(location, url).toString(), target, job, redirects - 1).then(resolvePromise, rejectPromise)
        return
      }
      if (status < 200 || status >= 300) {
        response.resume()
        rejectPromise(new Error(`GET ${url} returned ${status}`))
        return
      }

      const totalBytes = Number(response.headers['content-length']) || LOCAL_STT_MODEL_ARCHIVE_SIZE
      let receivedBytes = 0
      const output = createWriteStream(target)

      response.on('data', chunk => {
        receivedBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
        updateJob(job, {
          stage: 'download',
          percent: totalBytes ? Math.min(99, receivedBytes / totalBytes * 100) : undefined,
          receivedBytes,
          totalBytes,
        })
      })
      response.on('error', rejectPromise)
      output.on('error', rejectPromise)
      output.on('finish', () => output.close(() => resolvePromise()))
      response.pipe(output)
    })
    request.setTimeout(30_000, () => request.destroy(new Error('Local STT model download timed out')))
    request.on('error', error => rejectPromise(new Error(`GET ${url} failed: ${error.message}`)))
  })
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const input = createReadStream(file)
    input.on('data', chunk => hash.update(chunk))
    input.on('end', resolvePromise)
    input.on('error', rejectPromise)
  })
  return hash.digest('hex')
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function runtimeIdleTimeoutMs(): number {
  return positiveIntegerEnv('HERMES_LOCAL_STT_RUNTIME_IDLE_MS', DEFAULT_RUNTIME_IDLE_TIMEOUT_MS)
}

function streamSessionIdleTimeoutMs(): number {
  return positiveIntegerEnv('HERMES_LOCAL_STT_STREAM_IDLE_MS', DEFAULT_STREAM_SESSION_IDLE_TIMEOUT_MS)
}

function abortError(): Error {
  return Object.assign(new Error('STT request aborted'), { name: 'AbortError' })
}

function clearRuntimeIdleTimer(): void {
  if (!runtimeIdleTimer) return
  clearTimeout(runtimeIdleTimer)
  runtimeIdleTimer = null
}

function clearStreamSessions(): void {
  for (const session of streamSessions.values()) {
    if (session.idleTimer) clearTimeout(session.idleTimer)
  }
  streamSessions.clear()
}

function spawnModelProcess(): ChildProcess {
  return spawn(process.execPath, ['--expose-gc', '-e', LOCAL_STT_CHILD_SOURCE], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HERMES_LOCAL_STT_MODULE_PATH: requireFromServer.resolve('sherpa-onnx-node'),
    },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    windowsHide: true,
  })
}

function cleanupActiveModelCommand(command: ActiveModelCommand): void {
  clearTimeout(command.timeout)
  if (command.abort && command.signal) command.signal.removeEventListener('abort', command.abort)
}

function finishActiveModelCommand(
  command: ActiveModelCommand,
  callback: () => void,
): void {
  if (activeModelCommand !== command) return
  activeModelCommand = null
  cleanupActiveModelCommand(command)
  callback()
  scheduleRuntimeIdleStop()
}

function stopModelProcess(child: ChildProcess, graceful = true): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()

  return new Promise(resolvePromise => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(forceTimer)
      child.removeListener('exit', finish)
      resolvePromise()
    }
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        killOwnedProcessTree(child.pid, () => { child.kill('SIGKILL') })
      }
      finish()
    }, CHILD_EXIT_TIMEOUT_MS)
    forceTimer.unref?.()
    child.once('exit', finish)

    if (graceful && child.connected) {
      child.send({ action: 'shutdown' }, error => {
        if (error && child.exitCode === null && child.signalCode === null) {
          killOwnedProcessTree(child.pid, () => { child.kill('SIGTERM') })
        }
      })
    } else {
      killOwnedProcessTree(child.pid, () => { child.kill('SIGTERM') })
    }
  })
}

function failRuntimeProcess(child: ChildProcess, error: Error): void {
  if (runtimeChild === child) runtimeChild = null
  clearRuntimeIdleTimer()
  clearStreamSessions()

  const command = activeModelCommand
  if (command?.child === child) {
    activeModelCommand = null
    cleanupActiveModelCommand(command)
    command.reject(error)
  }

  void stopModelProcess(child, false)
}

function handleRuntimeMessage(child: ChildProcess, message: unknown): void {
  if (!message || typeof message !== 'object') return
  const result = message as Partial<ModelProcessResult>
  const command = activeModelCommand
  if (!command || command.child !== child || result.id !== command.id) return

  finishActiveModelCommand(command, () => {
    if (result.ok) {
      command.resolve(result as ModelProcessResult)
    } else {
      command.reject(new Error(result.error || 'Local STT runtime failed'))
    }
  })
}

function ensureRuntimeProcess(): ChildProcess {
  if (runtimeShuttingDown) throw new Error('Local STT runtime is shutting down')
  if (runtimeChild && runtimeChild.exitCode === null && runtimeChild.signalCode === null && runtimeChild.connected) {
    clearRuntimeIdleTimer()
    return runtimeChild
  }

  const child = spawnModelProcess()
  runtimeChild = child
  child.on('message', message => handleRuntimeMessage(child, message))
  child.once('error', error => failRuntimeProcess(child, error))
  child.once('exit', (code, signal) => {
    if (runtimeChild !== child && activeModelCommand?.child !== child) return
    const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`
    failRuntimeProcess(child, new Error(`Local STT runtime exited with ${detail}`))
  })
  return child
}

function scheduleRuntimeIdleStop(): void {
  clearRuntimeIdleTimer()
  if (runtimeShuttingDown || !runtimeChild || activeModelCommand || streamSessions.size > 0) return

  const child = runtimeChild
  runtimeIdleTimer = setTimeout(() => {
    runtimeIdleTimer = null
    if (runtimeChild !== child || activeModelCommand || streamSessions.size > 0) return
    runtimeChild = null
    void stopModelProcess(child)
  }, runtimeIdleTimeoutMs())
  runtimeIdleTimer.unref?.()
}

function dispatchModelCommand(
  command: Omit<ModelProcessCommand, 'id'>,
  signal?: AbortSignal,
): Promise<ModelProcessResult> {
  if (signal?.aborted) return Promise.reject(abortError())

  return new Promise((resolvePromise, rejectPromise) => {
    let child: ChildProcess
    try {
      child = ensureRuntimeProcess()
    } catch (error) {
      rejectPromise(error instanceof Error ? error : new Error(String(error)))
      return
    }

    const id = randomUUID()
    const timeout = setTimeout(() => {
      const active = activeModelCommand
      if (!active || active.id !== id) return
      finishActiveModelCommand(active, () => rejectPromise(new Error('Local STT runtime timed out')))
      failRuntimeProcess(child, new Error('Local STT runtime timed out'))
    }, TRANSCRIBE_TIMEOUT_MS)
    timeout.unref?.()

    const active: ActiveModelCommand = {
      id,
      child,
      signal,
      timeout,
      resolve: resolvePromise,
      reject: rejectPromise,
    }
    active.abort = () => {
      if (activeModelCommand !== active) return
      finishActiveModelCommand(active, () => rejectPromise(abortError()))
      failRuntimeProcess(child, abortError())
    }
    activeModelCommand = active
    signal?.addEventListener('abort', active.abort, { once: true })

    child.send({ ...command, id }, error => {
      if (!error || activeModelCommand !== active) return
      finishActiveModelCommand(active, () => rejectPromise(error))
      failRuntimeProcess(child, error)
    })
  })
}

function enqueueModelCommand(
  command: Omit<ModelProcessCommand, 'id'>,
  signal?: AbortSignal,
): Promise<ModelProcessResult> {
  const result = modelCommandQueue.then(
    () => dispatchModelCommand(command, signal),
    () => dispatchModelCommand(command, signal),
  )
  modelCommandQueue = result.then(() => undefined, () => undefined)
  return result
}

function runModelValidation(modelRoot: string): Promise<ModelProcessResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnModelProcess()
    const id = randomUUID()
    let result: ModelProcessResult | null = null
    let failure: Error | null = null
    let settled = false

    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (failure) rejectPromise(failure)
      else if (!result?.ok) rejectPromise(new Error(result?.error || 'Local STT model validation failed'))
      else resolvePromise(result)
    }
    const timeout = setTimeout(() => {
      failure = new Error('Local STT model validation timed out')
      void stopModelProcess(child, false).then(finish)
    }, TRANSCRIBE_TIMEOUT_MS)
    timeout.unref?.()

    child.on('message', message => {
      if (!message || typeof message !== 'object') return
      const next = message as ModelProcessResult
      if (next.id !== id) return
      result = next
      void stopModelProcess(child).then(finish)
    })
    child.once('error', error => {
      failure = error
      void stopModelProcess(child, false).then(finish)
    })
    child.once('exit', code => {
      if (!result && !failure) failure = new Error(`Local STT model validation process exited with code ${code}`)
      finish()
    })
    child.send({ id, action: 'validate', modelRoot }, error => {
      if (!error) return
      failure = error
      void stopModelProcess(child, false).then(finish)
    })
  })
}

async function installLocalSttModel(job: LocalSttModelDownloadJob): Promise<void> {
  const storageRoot = modelStorageRoot()
  const targetRoot = localSttModelDirectory()
  const archive = join(storageRoot, `${basename(LOCAL_STT_MODEL_ASSET_NAME)}.${job.id}.download`)
  const tempRoot = join(storageRoot, `.local-stt-${process.pid}-${Date.now()}`)

  mkdirSync(storageRoot, { recursive: true })
  rmSync(tempRoot, { recursive: true, force: true })
  mkdirSync(tempRoot, { recursive: true })

  try {
    updateJob(job, { stage: 'resolve' })
    await downloadFile(localSttModelAssetUrl(job.source), archive, job)

    updateJob(job, { stage: 'verify', percent: 100 })
    const actualSha256 = await sha256File(archive)
    if (actualSha256 !== LOCAL_STT_MODEL_ARCHIVE_SHA256) {
      throw new Error('Local STT model checksum mismatch')
    }

    updateJob(job, { stage: 'extract' })
    await tar.x({ file: archive, cwd: tempRoot, strip: 1, preserveOwner: false, unlink: true })
    const extracted = inspectRequiredModelFiles(tempRoot)
    if (!extracted.installed || extracted.validationError) {
      throw new Error(extracted.validationError || 'Local STT archive is missing required model files')
    }

    updateJob(job, { stage: 'validate' })
    await runModelValidation(tempRoot)
    writeFileSync(join(tempRoot, MODEL_MANIFEST_FILE), JSON.stringify({
      schema: MODEL_SCHEMA,
      id: LOCAL_STT_MODEL_ID,
      archiveSha256: LOCAL_STT_MODEL_ARCHIVE_SHA256,
      validatedAt: new Date().toISOString(),
    } satisfies LocalSttModelManifest, null, 2) + '\n', 'utf8')

    updateJob(job, { stage: 'install' })
    rmSync(targetRoot, { recursive: true, force: true })
    mkdirSync(dirname(targetRoot), { recursive: true })
    renameSync(tempRoot, targetRoot)
  } finally {
    rmSync(archive, { force: true })
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

export function startLocalSttModelDownload(source: LocalSttModelDownloadSource): LocalSttModelDownloadJob {
  const current = Array.from(jobs.values()).find(job => job.status === 'queued' || job.status === 'running')
  if (current) return { ...current }
  if (isLocalSttModelUsable()) throw new Error('Local STT model is already installed and usable')

  const now = new Date().toISOString()
  const job: LocalSttModelDownloadJob = {
    id: `local-stt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    source,
    status: 'queued',
    stage: 'queued',
    error: '',
    createdAt: now,
    updatedAt: now,
  }
  jobs.set(job.id, job)

  queueMicrotask(() => {
    updateJob(job, { status: 'running', stage: 'resolve' })
    installLocalSttModel(job)
      .then(() => updateJob(job, { status: 'completed', stage: 'completed', percent: 100 }))
      .catch(error => updateJob(job, {
        status: 'failed',
        stage: 'failed',
        error: error instanceof Error ? error.message : String(error),
      }))
  })

  return { ...job }
}

function isWav(input: Buffer): boolean {
  return input.length >= 12 && input.subarray(0, 4).toString('ascii') === 'RIFF' && input.subarray(8, 12).toString('ascii') === 'WAVE'
}

function isRawPcmS16le(mimeType: string): boolean {
  const normalized = String(mimeType || '').split(';')[0].trim().toLowerCase()
  return normalized === 'audio/x-pcm' || normalized === 'audio/pcm' || normalized === 'audio/l16'
}

export function prepareLocalSttWav(audio: Buffer, mimeType: string): Buffer {
  if (isWav(audio)) return audio
  if (!isRawPcmS16le(mimeType)) {
    throw new Error('Local STT accepts PCM WAV or raw 16 kHz mono s16le PCM audio')
  }
  if (!audio.length || audio.length % 2 !== 0) {
    throw new Error('Local STT raw PCM audio must contain complete 16-bit samples')
  }

  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + audio.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(LOCAL_STT_SAMPLE_RATE, 24)
  header.writeUInt32LE(LOCAL_STT_SAMPLE_RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(audio.length, 40)
  return Buffer.concat([header, audio])
}

async function prepareLocalSttUploadWav(audio: Buffer, mimeType: string): Promise<Buffer> {
  try {
    return prepareLocalSttWav(audio, mimeType)
  } catch (error) {
    const normalized = String(mimeType || '').split(';')[0].trim().toLowerCase()
    const looksLikeMp3 = (audio.length >= 3 && audio.subarray(0, 3).toString('ascii') === 'ID3')
      || (audio.length >= 2 && audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0)
    if (normalized !== 'audio/mpeg' && normalized !== 'audio/mp3' && !looksLikeMp3) throw error
    const decoded = await transcodeToPcmS16le(audio, 'audio/mpeg', { sampleRate: LOCAL_STT_SAMPLE_RATE })
    return prepareLocalSttWav(decoded.audio, decoded.mimeType)
  }
}

export async function transcribeWithLocalStt(input: SttTranscribeInput): Promise<SttTranscribeResult> {
  if (!isLocalSttModelUsable()) throw new Error('Local STT model is not installed or failed validation')
  if (input.signal?.aborted) throw Object.assign(new Error('STT request aborted'), { name: 'AbortError' })

  const audio = await prepareLocalSttUploadWav(input.audio, input.mimeType)

  const tempRoot = join(config.appHome, 'runtime', 'local-stt-audio')
  await mkdir(tempRoot, { recursive: true })
  const audioPath = join(tempRoot, `${randomUUID()}.wav`)
  await writeFile(audioPath, audio)

  try {
    const result = await enqueueModelCommand({
      action: 'transcribe',
      modelRoot: localSttModelDirectory(),
      audioPath,
    }, input.signal)
    const text = result.text?.trim() || ''
    if (!text) throw new SttNoSpeechDetectedError('No speech detected')
    return {
      text,
      provider: 'local',
      model: LOCAL_STT_MODEL_ID,
      durationMs: result.durationMs || 0,
    }
  } finally {
    await unlink(audioPath).catch(() => undefined)
  }
}

function streamSessionNotFound(): LocalSttStreamSessionError {
  return new LocalSttStreamSessionError('Local STT stream session was not found')
}

function getOwnedStreamSession(sessionId: string, ownerKey: string): LocalSttStreamSession {
  const session = streamSessions.get(sessionId)
  if (!session || session.ownerKey !== ownerKey) throw streamSessionNotFound()
  return session
}

function touchStreamSession(sessionId: string, session: LocalSttStreamSession): void {
  if (session.idleTimer) clearTimeout(session.idleTimer)
  session.idleTimer = setTimeout(() => {
    if (streamSessions.get(sessionId) !== session) return
    streamSessions.delete(sessionId)
    void enqueueModelCommand({ action: 'stream-cancel', sessionId }).catch(() => undefined)
  }, streamSessionIdleTimeoutMs())
  session.idleTimer.unref?.()
}

async function writeTemporaryLocalSttAudio(audio: Buffer, mimeType: string): Promise<string> {
  const wav = prepareLocalSttWav(audio, mimeType)
  const tempRoot = join(config.appHome, 'runtime', 'local-stt-audio')
  await mkdir(tempRoot, { recursive: true })
  const audioPath = join(tempRoot, `${randomUUID()}.wav`)
  await writeFile(audioPath, wav)
  return audioPath
}

export async function createLocalSttStreamSession(ownerKey: string): Promise<{ sessionId: string }> {
  if (!isLocalSttModelUsable()) throw new Error('Local STT model is not installed or failed validation')
  if (runtimeShuttingDown) throw new Error('Local STT runtime is shutting down')

  const sessionId = randomUUID()
  await enqueueModelCommand({
    action: 'stream-start',
    modelRoot: localSttModelDirectory(),
    sessionId,
  })
  const session: LocalSttStreamSession = { ownerKey, idleTimer: null }
  streamSessions.set(sessionId, session)
  clearRuntimeIdleTimer()
  touchStreamSession(sessionId, session)
  return { sessionId }
}

export async function pushLocalSttStreamAudio(
  sessionId: string,
  ownerKey: string,
  audio: Buffer,
  mimeType: string,
  signal?: AbortSignal,
): Promise<LocalSttStreamResult> {
  const session = getOwnedStreamSession(sessionId, ownerKey)
  touchStreamSession(sessionId, session)
  const audioPath = await writeTemporaryLocalSttAudio(audio, mimeType)

  try {
    const result = await enqueueModelCommand({
      action: 'stream-chunk',
      modelRoot: localSttModelDirectory(),
      sessionId,
      audioPath,
    }, signal)
    touchStreamSession(sessionId, getOwnedStreamSession(sessionId, ownerKey))
    return {
      sessionId,
      text: result.text?.trim() || '',
      model: LOCAL_STT_MODEL_ID,
      durationMs: result.durationMs || 0,
    }
  } finally {
    await unlink(audioPath).catch(() => undefined)
  }
}

export async function finishLocalSttStreamSession(
  sessionId: string,
  ownerKey: string,
  signal?: AbortSignal,
): Promise<LocalSttStreamResult> {
  const session = getOwnedStreamSession(sessionId, ownerKey)
  if (session.idleTimer) clearTimeout(session.idleTimer)
  streamSessions.delete(sessionId)

  const result = await enqueueModelCommand({
    action: 'stream-finish',
    modelRoot: localSttModelDirectory(),
    sessionId,
  }, signal)
  return {
    sessionId,
    text: result.text?.trim() || '',
    model: LOCAL_STT_MODEL_ID,
    durationMs: result.durationMs || 0,
  }
}

export async function cancelLocalSttStreamSession(sessionId: string, ownerKey: string): Promise<void> {
  const session = getOwnedStreamSession(sessionId, ownerKey)
  if (session.idleTimer) clearTimeout(session.idleTimer)
  streamSessions.delete(sessionId)
  await enqueueModelCommand({ action: 'stream-cancel', sessionId })
}

export async function shutdownLocalSttRuntime(): Promise<void> {
  if (runtimeShuttingDown) return
  runtimeShuttingDown = true
  clearRuntimeIdleTimer()
  clearStreamSessions()

  const child = runtimeChild
  runtimeChild = null
  const command = activeModelCommand
  if (command) {
    activeModelCommand = null
    cleanupActiveModelCommand(command)
    command.reject(new Error('Local STT runtime is shutting down'))
  }
  if (child) await stopModelProcess(child)
}
