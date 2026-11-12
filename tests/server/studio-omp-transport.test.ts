import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OmpRpc } from '../../plugins/builtin/omp/rpc.mjs'
import { binaryAsset, installEngine, engineStatus } from '../../plugins/builtin/omp/engine.mjs'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'

afterEach(() => vi.unstubAllGlobals())

it('reassembles UTF-8 RPC chunks and rejects out-of-order frames', async () => {
  const rpc = Object.assign(Object.create(OmpRpc.prototype), { pending: new Map(), listeners: new Set(), onEvent: vi.fn(), chunk: null })
  const bytes = Buffer.from(JSON.stringify({ type: 'fixture', text: '模型输出'.repeat(1000) }))
  const split = 101
  const frame = (index: number, data: Buffer) => ({ type: 'rpc_chunk', chunkId: 'large', index, count: 2, byteLength: bytes.length, data: data.toString('base64') })
  await rpc.frame(frame(0, bytes.subarray(0, split)))
  expect(rpc.onEvent).not.toHaveBeenCalled()
  await rpc.frame(frame(1, bytes.subarray(split)))
  expect(rpc.onEvent).toHaveBeenCalledWith(JSON.parse(bytes.toString()), rpc)
  await rpc.frame(frame(0, bytes.subarray(0, split)))
  await expect(rpc.frame(frame(0, bytes.subarray(split)))).rejects.toThrow('Invalid OMP chunk sequence')
})

it('rejects corrupt downloads without changing the selected engine or retaining a partial installation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-omp-install-'))
  try {
    const selected = JSON.stringify({ version: '18.18.0', asset: binaryAsset() })
    await writeFile(join(directory, 'engine.json'), selected)
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(url.endsWith('SHA256SUMS.txt') ? `${'0'.repeat(64)}  ${binaryAsset()}\n` : 'broken binary')))
    await expect(installEngine(directory, '18.19.0', new AbortController().signal)).rejects.toThrow('checksum verification failed')
    expect(await readFile(join(directory, 'engine.json'), 'utf8')).toBe(selected)
    expect(await readdir(join(directory, 'engines'))).toEqual([])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it.skipIf(!process.env.STUDIO_TEST_OMP_BINARY)('installs a verified real engine into the private managed directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-omp-managed-')), binary = process.env.STUDIO_TEST_OMP_BINARY!
  try {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(binary)) hash.update(chunk)
    const checksum = hash.digest('hex')
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/SHA256SUMS.txt')) return new Response(`${checksum}  ${binaryAsset()}\n`)
      if (url.endsWith('/LICENSE')) return new Response('MIT engine license fixture')
      return new Response(Readable.toWeb(createReadStream(binary)) as any)
    }))
    await expect(installEngine(directory, '18.19.0', new AbortController().signal)).resolves.toEqual({ installedVersion: '18.19.0' })
    expect(await engineStatus(directory, '', new AbortController().signal)).toMatchObject({ installed: true, version: '18.19.0', source: 'managed' })
    expect(await readFile(join(directory, 'engines/18.19.0/LICENSE'), 'utf8')).toBe('MIT engine license fixture')
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 60000)
