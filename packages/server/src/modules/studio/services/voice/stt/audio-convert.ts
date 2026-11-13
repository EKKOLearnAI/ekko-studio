import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { killOwnedProcessTree } from '../../../infrastructure/process-tree'

const TRANSCODE_TIMEOUT_MS = 30_000
const DEFAULT_PCM_SAMPLE_RATE = 16000

type DecodedAudio = {
  channelData: Float32Array[]
  sampleRate: number
}

type DecodeAudioModule = {
  default: (src: ArrayBuffer | Uint8Array) => Promise<DecodedAudio>
}

const requireAudioDecoder = createRequire(__filename)

/**
 * Check whether ffmpeg is available on the system PATH.
 */
let ffmpegAvailable: boolean | null = null

function runFfmpeg(args: string[], input: Buffer, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const errChunks: Buffer[] = []

    const child = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] })

    const timer = setTimeout(() => {
      killOwnedProcessTree(child.pid, () => { child.kill('SIGKILL') })
      reject(new Error('ffmpeg transcoding timed out'))
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk))

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString('utf-8').trim()
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`))
        return
      }
      resolve(Buffer.concat(chunks))
    })

    child.stdin.end(input)
  })
}

export async function isFfmpegAvailable(): Promise<boolean> {
  if (ffmpegAvailable !== null) return ffmpegAvailable
  try {
    await runFfmpeg(['-version'], Buffer.alloc(0), 5_000)
    ffmpegAvailable = true
  } catch {
    ffmpegAvailable = false
  }
  return ffmpegAvailable
}

/**
 * Transcode an audio buffer to WAV (PCM 16-bit, 16 kHz, mono) using ffmpeg.
 *
 * Most OpenAI-compatible STT services expect mp3/wav.  Browser MediaRecorder
 * typically produces webm/opus which some upstreams cannot decode.  This
 * helper bridges that gap.
 *
 * Returns the original buffer unchanged when ffmpeg is not available.
 */
export async function transcodeToWav(
  input: Buffer,
  mimeType: string,
  options: { normalizeWav?: boolean } = {},
): Promise<{ audio: Buffer; mimeType: string; fileName: string }> {
  if (!(await isFfmpegAvailable())) {
    return { audio: input, mimeType, fileName: '' }
  }

  // Already a WAV – no conversion needed.
  if (!options.normalizeWav && (mimeType === 'audio/wav' || mimeType === 'audio/x-wav')) {
    return { audio: input, mimeType, fileName: '' }
  }

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', 'pipe:0',          // read from stdin
    '-acodec', 'pcm_s16le',  // 16-bit PCM
    '-ar', '16000',          // 16 kHz sample rate
    '-ac', '1',              // mono
    '-f', 'wav',             // WAV container
    'pipe:1',                // write to stdout
  ]

  const wavBuffer = await runFfmpeg(args, input, TRANSCODE_TIMEOUT_MS)
  if (wavBuffer.length === 0) {
    throw new Error('ffmpeg produced empty output')
  }

  return {
    audio: wavBuffer,
    mimeType: 'audio/wav',
    fileName: 'audio.wav',
  }
}

/**
 * Transcode synthesized speech to MP3.
 *
 * Hermes' command TTS provider writes the response to an `.mp3` path, but not
 * every OpenAI-compatible speech endpoint can produce MP3 — Groq's Orpheus
 * models, for instance, only accept `response_format: wav`. Converting here
 * lets those providers be used without lying about the file's contents.
 * Without ffmpeg the audio is returned untouched.
 */
export async function transcodeToMp3(
  input: Buffer,
  mimeType: string,
): Promise<{ audio: Buffer; mimeType: string }> {
  const normalized = normalizeMimeType(mimeType)
  const wavBytes = looksLikeWav(input)
  const claimsMp3 = normalized.includes('mpeg') || normalized.includes('mp3')
  if (looksLikeMp3(input) || (!wavBytes && claimsMp3)) {
    return { audio: input, mimeType: 'audio/mpeg' }
  }
  if (!(await isFfmpegAvailable())) {
    return { audio: input, mimeType }
  }

  const mp3Buffer = await runFfmpeg([
    '-hide_banner',
    '-loglevel', 'error',
    '-i', 'pipe:0',
    '-codec:a', 'libmp3lame',
    '-q:a', '2',
    '-f', 'mp3',
    'pipe:1',
  ], input, TRANSCODE_TIMEOUT_MS)

  if (mp3Buffer.length === 0) {
    throw new Error('ffmpeg produced empty output')
  }
  return { audio: mp3Buffer, mimeType: 'audio/mpeg' }
}

export async function transcodeToPcmS16le(
  input: Buffer,
  mimeType: string,
  options: { sampleRate?: number } = {},
): Promise<{ audio: Buffer; mimeType: string; fileName: string }> {
  const sampleRate = Number.isInteger(options.sampleRate) && Number(options.sampleRate) > 0
    ? Number(options.sampleRate)
    : DEFAULT_PCM_SAMPLE_RATE

  const decoded = await decodeAudioForPcm(input, mimeType)
  const mono = mixToMono(decoded.channelData)
  const resampled = resampleLinear(mono, decoded.sampleRate, sampleRate)
  const pcmBuffer = floatToS16le(resampled)

  if (pcmBuffer.length === 0) {
    throw new Error('audio decode produced empty PCM output')
  }

  return {
    audio: pcmBuffer,
    mimeType: 'audio/x-pcm',
    fileName: 'audio.pcm',
  }
}

async function decodeAudioForPcm(input: Buffer, mimeType: string): Promise<DecodedAudio> {
  const normalized = normalizeMimeType(mimeType)
  const kind = normalized.includes('mpeg') || normalized.includes('mp3') || looksLikeMp3(input)
    ? 'mp3'
    : normalized.includes('wav') || normalized.includes('wave') || looksLikeWav(input)
      ? 'wav'
      : ''

  if (!kind) {
    throw new Error(`unsupported audio format for MCU PCM decode: ${mimeType || 'unknown content type'}`)
  }

  try {
    const mod = requireAudioDecoder(kind === 'mp3' ? '@audio/decode-mp3' : '@audio/decode-wav') as DecodeAudioModule
    const decoded = await mod.default(input)
    if (!decoded.channelData.length || !decoded.channelData[0]?.length || !Number.isFinite(decoded.sampleRate) || decoded.sampleRate <= 0) {
      throw new Error('decoded audio is empty')
    }
    return decoded
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`MCU PCM decode failed for ${kind}: ${message}`)
  }
}

function normalizeMimeType(mimeType: string): string {
  return String(mimeType || '').split(';')[0].trim().toLowerCase()
}

function looksLikeWav(input: Buffer): boolean {
  return input.length >= 12 && input.subarray(0, 4).toString('ascii') === 'RIFF' && input.subarray(8, 12).toString('ascii') === 'WAVE'
}

function looksLikeMp3(input: Buffer): boolean {
  if (input.length >= 3 && input.subarray(0, 3).toString('ascii') === 'ID3') return true
  return input.length >= 2 && input[0] === 0xff && (input[1] & 0xe0) === 0xe0
}

function mixToMono(channels: Float32Array[]): Float32Array {
  const validChannels = channels.filter(channel => channel.length > 0)
  if (!validChannels.length) return new Float32Array(0)
  if (validChannels.length === 1) return validChannels[0]

  const sampleCount = Math.max(...validChannels.map(channel => channel.length))
  const mono = new Float32Array(sampleCount)
  for (let i = 0; i < sampleCount; i += 1) {
    let sum = 0
    for (const channel of validChannels) {
      sum += channel[i] ?? 0
    }
    mono[i] = sum / validChannels.length
  }
  return mono
}

function resampleLinear(input: Float32Array, sourceRate: number, targetRate: number): Float32Array {
  if (!input.length) return input
  if (sourceRate === targetRate) return input

  const outputLength = Math.max(1, Math.round(input.length * targetRate / sourceRate))
  const output = new Float32Array(outputLength)
  const scale = sourceRate / targetRate

  for (let i = 0; i < outputLength; i += 1) {
    const sourceIndex = i * scale
    const left = Math.floor(sourceIndex)
    const right = Math.min(left + 1, input.length - 1)
    const weight = sourceIndex - left
    output[i] = input[left] * (1 - weight) + input[right] * weight
  }

  return output
}

function floatToS16le(samples: Float32Array): Buffer {
  const output = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Number.isFinite(samples[i]) ? Math.max(-1, Math.min(1, samples[i])) : 0
    const int16 = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767)
    output.writeInt16LE(int16, i * 2)
  }
  return output
}
