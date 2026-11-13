import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { MeetingASRService } from '../../packages/server/src/modules/studio/services/meeting-asr/index'

/**
 * The whole-file transcription dialog lets the user pick either ASR engine per
 * action, independent of the session's provider. A running backend therefore
 * has to receive *both* credentials — MiniMax included when the session was
 * created on DashScope — so the hot config push must forward the MiniMax
 * fields, not only the DashScope ones.
 *
 * The push goes over `node:http` (undici cannot accept the node:https.Agent
 * needed for the self-signed backend cert), so these tests use a real loopback
 * server instead of stubbing fetch.
 */
describe('MeetingASRService.updateConfig', () => {
  const svc = MeetingASRService.getInstance() as any
  const prevRunning = svc._isRunning
  const prevPort = svc._asrPort
  const bodies: string[] = []
  let server: Server

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        bodies.push(Buffer.concat(chunks).toString('utf-8'))
        res.setHeader('content-type', 'application/json')
        res.end('{"status":"ok"}')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  afterEach(() => {
    bodies.length = 0
    vi.restoreAllMocks()
    svc._isRunning = prevRunning
    svc._asrPort = prevPort
  })

  it('forwards MiniMax credentials alongside the DashScope key', async () => {
    svc._isRunning = true
    svc._asrPort = (server.address() as AddressInfo).port

    await svc.updateConfig({
      dashscopeApiKey: 'sk-dashscope',
      minimaxApiKey: 'mm-secret',
      minimaxAsrModel: 'asr-1.0',
      minimaxBaseUrl: 'https://api.minimaxi.com',
    } as any)

    expect(bodies).toHaveLength(1)
    const body = JSON.parse(bodies[0])
    expect(body.asr.dashscope_api_key).toBe('sk-dashscope')
    expect(body.asr.minimax_api_key).toBe('mm-secret')
    expect(body.asr.minimax_asr_model).toBe('asr-1.0')
    expect(body.asr.minimax_base_url).toBe('https://api.minimaxi.com')
  })

  it('leaves the MiniMax fields undefined when no key is available', async () => {
    svc._isRunning = true
    svc._asrPort = (server.address() as AddressInfo).port

    await svc.updateConfig({ dashscopeApiKey: 'sk-dashscope' } as any)

    const body = JSON.parse(bodies[0])
    // JSON.stringify drops undefined → the Python side keeps the previous value
    expect(body.asr.minimax_api_key).toBeUndefined()
  })

  it('refuses to push config while the service is stopped', async () => {
    svc._isRunning = false
    await expect(svc.updateConfig({ minimaxApiKey: 'mm' } as any)).rejects.toThrow(/not running/i)
  })
})

/**
 * A rebuild replaces `python-backend/` on disk but a long-lived uvicorn child
 * keeps the modules it imported at spawn. That is why an already-fixed bug can
 * keep reproducing after a page refresh. The service therefore hashes the
 * sources and respawns when they changed.
 */
describe('MeetingASRService backend staleness detection', () => {
  const svc = MeetingASRService.getInstance() as any
  const prevHash = svc._backendCodeHash

  afterEach(() => {
    svc._backendCodeHash = prevHash
  })

  it('produces a stable 16-char hash of the bundled sources', () => {
    const first = svc.computeBackendCodeHash()
    const second = svc.computeBackendCodeHash()
    expect(first).toMatch(/^[0-9a-f]{16}$/)
    expect(second).toBe(first)
  })

  it('treats an unknown hash as not stale (nothing to compare against)', () => {
    svc._backendCodeHash = null
    expect(svc.isBackendCodeStale()).toBe(false)
  })

  it('is not stale when the running child matches the sources on disk', () => {
    svc._backendCodeHash = svc.computeBackendCodeHash()
    expect(svc.isBackendCodeStale()).toBe(false)
  })

  it('is stale when the sources on disk changed since the child was spawned', () => {
    svc._backendCodeHash = 'deadbeefdeadbeef'
    expect(svc.isBackendCodeStale()).toBe(true)
  })

  it('exposes the code hash on the public status payload', () => {
    svc._backendCodeHash = 'abc123abc123abc1'
    expect(svc.status.codeHash).toBe('abc123abc123abc1')
  })
})

/**
 * Diagnosability: when the Python child dies mid-job the UI sees a bare 503.
 * The child's output is only logged at debug level (uvicorn access logs are
 * noisy), so the crash reason must survive in a bounded tail and be surfaced
 * through `status.error` — which the 503 body now carries as `detail`.
 */
describe('MeetingASRService crash diagnostics', () => {
  const svc = MeetingASRService.getInstance() as any

  afterEach(() => {
    svc._mainLogTail = []
  })

  it('keeps a bounded tail of the child output, one entry per line', () => {
    svc._recordMainLog('first line\nsecond line\r\nthird line')
    expect(svc._mainLogTail).toEqual(['first line', 'second line', 'third line'])

    for (let i = 0; i < 100; i++) svc._recordMainLog(`extra-${i}`)
    expect(svc._mainLogTail.length).toBeLessThanOrEqual(25)
    expect(svc._mainLogTail.at(-1)).toBe('extra-99')
    // the earliest lines were dropped, not the newest
    expect(svc._mainLogTail).not.toContain('first line')
  })

  it('ignores blank lines so the tail stays informative', () => {
    svc._recordMainLog('\n\n   \nreal line\n')
    expect(svc._mainLogTail).toEqual(['real line'])
  })

  it('reports the tail through status.error when the child exits unexpectedly', () => {
    const source = readFileSync(
      'packages/server/src/modules/studio/services/meeting-asr/index.ts',
      'utf8',
    )
    expect(source).toContain('_recordMainLog(data)')
    // reason includes the tail and lands in _error → status.detail
    expect(source).toMatch(/const reason = `main process exited unexpectedly \(code \$\{code\}\)/)
    expect(source).toMatch(/this\._error = reason/)
    expect(source).toMatch(/_scheduleRestart\(reason\)/)
    // a new spawn starts from a clean tail
    expect(source).toMatch(/this\._mainLogTail = \[\]/)
  })
})
