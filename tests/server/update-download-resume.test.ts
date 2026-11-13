/**
 * Tests for the HTTP Range resume downloader (phase a).
 *
 * Master spec: docs/harness/source-deploy-refactor.md (§ Download & Resume).
 * Uses a local node:http server so behaviour is exercised end-to-end
 * without network access.
 */
import { createServer, type Server } from 'http'
import { createHash } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { downloadWithRangeResume, UpdateBinaryValidationError } from '../../packages/server/src/modules/studio/services/update/network-client'

let server: Server
let baseUrl = ''
let mode: 'range' | 'ignore-range' = 'range'
const tempDirs: string[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    const payload = Buffer.from(PAYLOAD)
    const range = req.headers.range
    if (mode === 'range' && range) {
      const match = /^bytes=(\d+)-$/.exec(range)
      const start = match ? Number.parseInt(match[1], 10) : 0
      const body = payload.subarray(start)
      res.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(body.length),
        'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}`,
      })
      res.end(body)
      return
    }
    // Either no Range requested, or the server ignores it (200 fallback test).
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(payload.length),
    })
    res.end(payload)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

afterEach(() => {
  mode = 'range'
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const PAYLOAD = Array.from({ length: 256 * 1024 }, (_, i) => String.fromCharCode(48 + (i % 64))).join('') +
  'tail-marker'.repeat(100)
const PAYLOAD_SHA = createHash('sha256').update(PAYLOAD).digest('hex')
const WRONG_SHA = 'f'.repeat(64)

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'range-resume-'))
  tempDirs.push(dir)
  return dir
}

interface Paths {
  partialFile: string
  metaFile: string
}

function paths(dir: string): Paths {
  return {
    partialFile: join(dir, 'partial-task-1.part'),
    metaFile: join(dir, 'partial-task-1.part.meta'),
  }
}

describe('downloadWithRangeResume', () => {
  it('downloads a fresh artifact and verifies sha256', async () => {
    const dir = scratchDir()
    const p = paths(dir)
    const result = await downloadWithRangeResume({
      urls: [`${baseUrl}/artifact`],
      expectedSize: PAYLOAD.length,
      expectedSha256: PAYLOAD_SHA,
      partialFile: p.partialFile,
      metaFile: p.metaFile,
    })
    expect(result.ok).toBe(true)
    expect(result.resumedFromByte).toBe(0)
    expect(result.sha256).toBe(PAYLOAD_SHA)
    expect(existsSync(p.partialFile)).toBe(true)
    // meta sidecar is removed on success
    expect(existsSync(p.metaFile)).toBe(false)
  })

  it('resumes from the durable offset and completes the artifact', async () => {
    const dir = scratchDir()
    const p = paths(dir)
    const resumeAt = 64 * 1024
    writeFileSync(p.partialFile, PAYLOAD.slice(0, resumeAt))
    writeFileSync(p.metaFile, JSON.stringify({
      expectedSha256: PAYLOAD_SHA,
      expectedSize: PAYLOAD.length,
      lastByte: resumeAt,
    }))

    let servedFrom = -1
    const originalListener = server.listeners('request')[0]
    server.removeAllListeners('request')
    server.on('request', (req, res) => {
      servedFrom = Number.parseInt((req.headers.range as string || 'bytes=0-').replace('bytes=', '').replace('-', ''), 10)
      ;(originalListener as any)(req, res)
    })

    try {
      const result = await downloadWithRangeResume({
        urls: [`${baseUrl}/artifact`],
        expectedSize: PAYLOAD.length,
        expectedSha256: PAYLOAD_SHA,
        partialFile: p.partialFile,
        metaFile: p.metaFile,
      })
      expect(result.resumedFromByte).toBe(resumeAt)
      expect(result.ok).toBe(true)
      expect(servedFrom).toBe(resumeAt)
      expect(readFileSync(p.partialFile, 'utf8')).toBe(PAYLOAD)
      expect(existsSync(p.metaFile)).toBe(false)
    } finally {
      server.removeAllListeners('request')
      server.on('request', originalListener as any)
    }
  })

  it('truncates bytes beyond the durable offset before resuming', async () => {
    const dir = scratchDir()
    const p = paths(dir)
    const resumeAt = 32 * 1024
    // Torn tail: more bytes on disk than the meta records.
    writeFileSync(p.partialFile, PAYLOAD.slice(0, resumeAt + 4096))
    writeFileSync(p.metaFile, JSON.stringify({
      expectedSha256: PAYLOAD_SHA,
      expectedSize: PAYLOAD.length,
      lastByte: resumeAt,
    }))
    const result = await downloadWithRangeResume({
      urls: [`${baseUrl}/artifact`],
      expectedSha256: PAYLOAD_SHA,
      partialFile: p.partialFile,
      metaFile: p.metaFile,
    })
    expect(result.ok).toBe(true)
    expect(readFileSync(p.partialFile, 'utf8')).toBe(PAYLOAD)
  })

  it('restarts from byte 0 when the server ignores Range (200 fallback)', async () => {
    const dir = scratchDir()
    const p = paths(dir)
    writeFileSync(p.partialFile, PAYLOAD.slice(0, 1024))
    writeFileSync(p.metaFile, JSON.stringify({
      expectedSha256: PAYLOAD_SHA,
      expectedSize: PAYLOAD.length,
      lastByte: 1024,
    }))
    mode = 'ignore-range'
    const result = await downloadWithRangeResume({
      urls: [`${baseUrl}/artifact`],
      expectedSha256: PAYLOAD_SHA,
      partialFile: p.partialFile,
      metaFile: p.metaFile,
    })
    expect(result.ok).toBe(true)
    expect(result.resumedFromByte).toBe(0)
    expect(readFileSync(p.partialFile, 'utf8')).toBe(PAYLOAD)
  })

  it('falls through to the next mirror when one is unreachable', async () => {
    const dir = scratchDir()
    const p = paths(dir)
    // Dead port: connection refused.
    const deadUrl = 'http://127.0.0.1:9/artifact'
    const result = await downloadWithRangeResume({
      urls: [deadUrl, `${baseUrl}/artifact`],
      expectedSha256: PAYLOAD_SHA,
      partialFile: p.partialFile,
      metaFile: p.metaFile,
      retries: 0,
      retryDelayMs: 1,
    })
    expect(result.ok).toBe(true)
    expect(result.url).toBe(`${baseUrl}/artifact`)
  })

  it('raises sha256_mismatch after all mirrors return bad bytes', async () => {
    const dir = scratchDir()
    const p = paths(dir)
    let err: unknown = null
    try {
      await downloadWithRangeResume({
        urls: [`${baseUrl}/artifact`],
        expectedSha256: WRONG_SHA,
        partialFile: p.partialFile,
        metaFile: p.metaFile,
        retries: 0,
        retryDelayMs: 1,
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(UpdateBinaryValidationError)
    expect((err as UpdateBinaryValidationError).reason).toBe('sha256_mismatch')
    // The partial file is preserved for forensics (not deleted).
    expect(existsSync(p.partialFile)).toBe(true)
  })

  it('ignores a meta file whose expected sha does not match (fresh start)', async () => {
    const dir = scratchDir()
    const p = paths(dir)
    writeFileSync(p.partialFile, PAYLOAD.slice(0, 1024))
    writeFileSync(p.metaFile, JSON.stringify({
      expectedSha256: WRONG_SHA,
      expectedSize: PAYLOAD.length,
      lastByte: 1024,
    }))
    const result = await downloadWithRangeResume({
      urls: [`${baseUrl}/artifact`],
      expectedSha256: PAYLOAD_SHA,
      partialFile: p.partialFile,
      metaFile: p.metaFile,
    })
    expect(result.ok).toBe(true)
    expect(result.resumedFromByte).toBe(0)
  })

  it('renames the verified artifact to finalFile when provided', async () => {
    const dir = scratchDir()
    const p = paths(dir)
    const finalFile = join(dir, 'artifact.tar.gz')
    await downloadWithRangeResume({
      urls: [`${baseUrl}/artifact`],
      expectedSha256: PAYLOAD_SHA,
      partialFile: p.partialFile,
      metaFile: p.metaFile,
      finalFile,
    })
    expect(existsSync(finalFile)).toBe(true)
    expect(existsSync(p.partialFile)).toBe(false)
  })
})
