import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { AddressInfo } from 'node:net'

/**
 * TLS regression for the meeting-ASR proxy.
 *
 * Device images can spawn uvicorn with a self-signed cert
 * (`HERMES_WEB_UI_MEETING_ASR_TLS=true`). The proxy used to pass a
 * `node:https.Agent` as undici's `dispatcher`, which undici rejects with
 * `agent.dispatch is not a function` — every proxied call then returned 502
 * while the raw-upload path (which already used node:https) worked. That is
 * exactly "upload gets a job id, then status polling fails with 502".
 */

const status = {
  isRunning: true,
  asrPort: 0,
  useTls: true,
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
  proxyHealthCheck,
} from '../../packages/server/src/modules/studio/controllers/meeting-asr'

const captured: { path: string; body: Buffer }[] = []
let server: Server
let tmpDir = ''
let opensslAvailable = true

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

beforeAll(async () => {
  opensslAvailable = hasOpenssl()
  if (!opensslAvailable) return

  tmpDir = mkdtempSync(join(tmpdir(), 'meeting-asr-tls-'))
  const keyPath = join(tmpDir, 'key.pem')
  const certPath = join(tmpDir, 'cert.pem')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-subj', '/CN=localhost',
  ], { stdio: 'ignore' })

  server = createServer(
    { key: readFileSync(keyPath), cert: readFileSync(certPath) },
    (req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        captured.push({ path: req.url || '', body: Buffer.concat(chunks) })
        res.setHeader('content-type', 'application/json')
        if ((req.url || '').startsWith('/healthz')) {
          res.end(JSON.stringify({ status: 'ok', asr_model: 'paraformer-v2', llm_model: 'x' }))
          return
        }
        if ((req.url || '').startsWith('/api/transcribe/status/')) {
          res.end(JSON.stringify({ job_id: 'job-tls', status: 'running', progress: 0.5 }))
          return
        }
        res.end(JSON.stringify({ job_id: 'job-tls-1', status: 'pending' }))
      })
    },
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  status.asrPort = (server.address() as AddressInfo).port
})

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
})

describe('meeting-ASR proxy over a self-signed TLS backend', () => {
  it('proxies JSON routes (status / healthz) instead of failing with 502', async () => {
    if (!opensslAvailable) return

    const statusCtx = { params: { jobId: 'job-tls' }, status: 200, body: undefined, set: vi.fn() } as any
    await getFileTranscriptionStatus(statusCtx)
    expect(statusCtx.status).toBe(200)
    expect(statusCtx.body).toMatchObject({ status: 'running', progress: 0.5 })

    const healthCtx = { status: 200, body: undefined, set: vi.fn() } as any
    await proxyHealthCheck(healthCtx)
    expect(healthCtx.status).toBe(200)
    expect(healthCtx.body).toMatchObject({ status: 'ok' })
  })

  it('streams the raw audio upload over TLS', async () => {
    if (!opensslAvailable) return

    captured.length = 0
    const audio = Buffer.from('webm-bytes-over-tls')
    const req = Readable.from([audio]) as any
    const ctx = {
      req,
      request: { length: audio.length, type: 'audio/webm' },
      query: { engine: 'minimax', diarize: 'true' },
      params: {},
      status: 200,
      body: undefined,
      set: vi.fn(),
      type: undefined,
    } as any

    await startFileTranscription(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toMatchObject({ job_id: 'job-tls-1' })
    expect(captured[0].body.toString()).toBe('webm-bytes-over-tls')
  })

  it('does not send the request over plain HTTP when TLS is enabled', async () => {
    if (!opensslAvailable) return
    // A plain-HTTP client would get a protocol error against an HTTPS server;
    // the shared transport must pick https whenever status.useTls is set.
    const ctx = { status: 200, body: undefined, set: vi.fn() } as any
    await proxyHealthCheck(ctx)
    expect(ctx.status).toBe(200)
  })

  it('reports 503 (not 502) when the service is not running', async () => {
    status.isRunning = false
    try {
      const ctx = { params: { jobId: 'x' }, status: 200, body: undefined, set: vi.fn() } as any
      await getFileTranscriptionStatus(ctx)
      expect(ctx.status).toBe(503)
      expect(ctx.body).toMatchObject({ error: expect.stringContaining('not running') })
    } finally {
      status.isRunning = true
    }
  })
})
