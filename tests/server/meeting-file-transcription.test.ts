import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import type { AddressInfo } from 'node:net'

/**
 * Whole-file transcription proxy tests.
 *
 * The controller streams the raw audio body to the local ASR backend and
 * exposes the backend job status. These tests spin up a real loopback HTTP
 * server in place of the Python backend so the byte-level piping, the
 * camelCase → snake_case query mapping and the size guard are all exercised
 * for real (no node:http mock).
 */

const status = {
  isRunning: true,
  asrPort: 0,
  useTls: false,
  error: null as string | null,
}

vi.mock('../../packages/server/src/modules/studio/services/meeting-asr', () => ({
  meetingASRService: {
    get status() {
      return status
    },
  },
}))

import {
  getFileTranscriptionStatus,
  startFileTranscription,
} from '../../packages/server/src/modules/studio/controllers/meeting-asr'

interface Captured {
  path: string
  body: Buffer
  contentType: string
}

const captured: Captured[] = []
let server: http.Server

function makeCtx(options: {
  query?: Record<string, string>
  audio?: Buffer
  contentType?: string
  declaredLength?: number
} = {}) {
  const audio = options.audio ?? Buffer.from('fake-webm-audio')
  const req = Readable.from([audio]) as any
  return {
    req,
    request: {
      length: options.declaredLength ?? audio.length,
      type: options.contentType ?? 'audio/webm',
    },
    query: options.query ?? {},
    params: {},
    status: 200,
    body: undefined as any,
    set: vi.fn(),
    type: undefined as any,
  }
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      captured.push({
        path: req.url || '',
        body: Buffer.concat(chunks),
        contentType: String(req.headers['content-type'] || ''),
      })
      if ((req.url || '').startsWith('/api/transcribe/status/')) {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ job_id: 'job-9', status: 'running', progress: 0.3 }))
        return
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ job_id: 'job-1', status: 'pending' }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  status.asrPort = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  captured.length = 0
  status.isRunning = true
  status.error = null
})

describe('startFileTranscription', () => {
  it('streams the audio body and returns the backend job id', async () => {
    const ctx = makeCtx({
      query: { engine: 'minimax', diarize: 'true', speakerCount: '3', language: 'zh', sessionId: 's-1' },
      audio: Buffer.from('audio-payload-123'),
    })
    await startFileTranscription(ctx as any)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toMatchObject({ job_id: 'job-1', status: 'pending' })
    expect(captured).toHaveLength(1)
    expect(captured[0].body.toString()).toBe('audio-payload-123')
    expect(captured[0].contentType).toBe('audio/webm')

    const url = new URL(`http://local${captured[0].path}`)
    expect(url.pathname).toBe('/api/transcribe/file')
    expect(url.searchParams.get('engine')).toBe('minimax')
    expect(url.searchParams.get('diarize')).toBe('true')
    expect(url.searchParams.get('speaker_count')).toBe('3')
    expect(url.searchParams.get('language')).toBe('zh')
    expect(url.searchParams.get('session_id')).toBe('s-1')
  })

  it('normalizes the dashscope alias onto the qwen engine and invalid counts to 0', async () => {
    const ctx = makeCtx({
      query: { engine: 'dashscope', diarize: 'false', speakerCount: 'auto' },
    })
    await startFileTranscription(ctx as any)

    const url = new URL(`http://local${captured[0].path}`)
    expect(url.searchParams.get('engine')).toBe('qwen')
    expect(url.searchParams.get('diarize')).toBe('false')
    expect(url.searchParams.get('speaker_count')).toBe('0')
  })

  it('rejects oversize uploads before streaming any bytes', async () => {
    const ctx = makeCtx({ declaredLength: 500 * 1024 * 1024 })
    await startFileTranscription(ctx as any)

    expect(ctx.status).toBe(413)
    expect(captured).toHaveLength(0)
  })

  it('returns 503 when the ASR backend is not running', async () => {
    status.isRunning = false
    const ctx = makeCtx()
    await startFileTranscription(ctx as any)

    expect(ctx.status).toBe(503)
    expect(captured).toHaveLength(0)
  })
})

describe('getFileTranscriptionStatus', () => {
  it('proxies the backend job status', async () => {
    const ctx = { params: { jobId: 'job-9' }, status: 200, body: undefined, set: vi.fn() } as any
    await getFileTranscriptionStatus(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toMatchObject({ job_id: 'job-9', status: 'running', progress: 0.3 })
    expect(captured[0].path).toBe('/api/transcribe/status/job-9')
  })

  it('rejects a malformed job id without touching the backend', async () => {
    const ctx = { params: { jobId: '../../etc/passwd' }, status: 200, body: undefined, set: vi.fn() } as any
    await getFileTranscriptionStatus(ctx)

    expect(ctx.status).toBe(400)
    expect(captured).toHaveLength(0)
  })
})

/**
 * Source guardrails for the stale-backend self-heal. A rebuild only replaces
 * files on disk; the uvicorn child keeps its imported modules, so the client
 * must notice the mismatch and force a restart — otherwise a fixed bug keeps
 * reproducing until someone restarts the service by hand.
 */
describe('stale ASR backend self-heal wiring', () => {
  it('MeetingView probes the backend capability and restarts when stale', () => {
    const source = readFileSync(
      'packages/client/src/views/hermes/MeetingView.vue',
      'utf8',
    )
    expect(source).toContain('const TRANSCRIBE_CAPABILITY =')
    expect(source).toContain('ensureTranscribeBackend')
    // probes /healthz for both the capability marker and the code hash
    expect(source).toContain('health.transcribe')
    expect(source).toContain('health.code_hash')
    // stale → stop the service so the next start respawns the Python child
    expect(source).toContain('await meetingASRApi.stop()')
    // both whole-file entry points go through the guard
    const guardUses = source.match(/await ensureTranscribeBackend\(\)/g) ?? []
    expect(guardUses.length).toBeGreaterThanOrEqual(2)
  })

  it('the service hashes the sources, stamps the child and reports it', () => {
    const source = readFileSync(
      'packages/server/src/modules/studio/services/meeting-asr/index.ts',
      'utf8',
    )
    expect(source).toContain('computeBackendCodeHash')
    expect(source).toContain('isBackendCodeStale')
    // stamped into the child env so /healthz can echo it
    expect(source).toContain('env.MEETING_ASR_CODE_HASH = codeHash')
    // restart decision lives in start()
    expect(source).toContain('codeChanged')
  })
})

/**
 * Diarization output must be visible and renameable in the transcript.
 *
 * `HIDE_SPEAKER_DIARIZATION` used to be wired straight into TranscriptList,
 * which suppressed the speaker chips — so a successful 「拆分人声」 looked like
 * it had produced no speakers at all. The realtime toolbar switch and the
 * transcript display are separate concerns.
 */
describe('transcript speaker display + rename wiring', () => {
  const source = readFileSync('packages/client/src/views/hermes/MeetingView.vue', 'utf8')

  it('always renders speaker labels in the transcript', () => {
    expect(source).toContain('const HIDE_TRANSCRIPT_SPEAKERS = false')
    expect(source).toContain(':hide-speaker-diarization="HIDE_TRANSCRIPT_SPEAKERS"')
    // the old wiring (transcript controlled by the realtime toolbar switch) is gone
    expect(source).not.toMatch(/<TranscriptList[\s\S]{0,400}hide-speaker-diarization="HIDE_SPEAKER_DIARIZATION"/)
  })

  it('keeps the realtime toolbar switch separate from the transcript display', () => {
    expect(source).toContain('const HIDE_SPEAKER_DIARIZATION = true')
    // MeetingTopBar (realtime controls) still consumes it
    expect(source).toMatch(/hide-speaker-diarization="HIDE_SPEAKER_DIARIZATION"/)
  })

  it('persists renames to the server so a reload does not revert them', () => {
    // loadMeeting prefers server data, so a localStorage-only rename is lost
    const renameBlock = source.match(/function onTranscriptRename[\s\S]*?\n\}/)?.[0] ?? ''
    expect(renameBlock).toContain('renameSpeaker')
    expect(renameBlock).toContain('saveCurrentMeeting()')
  })
})
