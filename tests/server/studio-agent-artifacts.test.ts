import { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import sharp from 'sharp'
import { afterEach, expect, it } from 'vitest'
import { AgentArtifacts, MAX_AGENT_IMAGE_BYTES } from '../../packages/server/src/modules/studio/services/agents/artifacts'
import { AgentExecutionStore } from '../../packages/server/src/modules/studio/repositories/agent-execution-store'
import { createExecutionContext } from '../../packages/server/src/modules/studio/services/context/execution'
import { StudioError, readAgentImages, type ArtifactChunk, type ExecutionScope } from '../../packages/studio-plugin-sdk/src'

const scope: ExecutionScope = { scopeId: 's', principal: { kind: 'user', id: 'alice' }, profileId: 'one', surface: 'api', traceId: 't' }
const databases: DatabaseSync[] = []
afterEach(() => { databases.splice(0).forEach(db => db.close()) })
const png = () => sharp({ create: { width: 2, height: 2, channels: 3, background: 'white' } }).png().toBuffer()
function setup() {
  const db = new DatabaseSync(':memory:'); databases.push(db)
  const runs = new AgentExecutionStore(db)
  let allowed = true
  const authorize = () => { if (!allowed) throw new StudioError('FORBIDDEN', 'revoked') }
  const artifacts = new AgentArtifacts(db, runs, authorize)
  const instance = runs.createInstance({ agentTypeId: 'fixture', config: {}, mode: 'global', ownerId: 'alice', profileId: 'one' })
  const createRun = (id: string) => {
    const { run } = runs.accept(instance, { kind: 'builtin', module: 'ekko', implementationVersion: 'test' },
      { content: [{ type: 'image', artifactId: id, mediaType: 'image/png' }] }, id)
    runs.transition(run.id, ['accepted'], 'running')
    return { ...scope, runId: run.id }
  }
  return { db, runs, artifacts, instance, createRun, revoke: () => { allowed = false } }
}
it('reads accepted chat images after completion and rejects drafts, other chats, owners and profiles', async () => {
  const f = setup(), data = await png(), image = await f.artifacts.create(scope, data, new AbortController().signal)
  expect(() => f.artifacts.readForChat(scope, 'chat', image.id)).toThrow(/attached/)
  const input = { content: [{ type: 'image' as const, artifactId: image.id, mediaType: image.mediaType }] }
  const { run } = f.runs.accept(f.instance, { kind: 'builtin', module: 'ekko', implementationVersion: 'test' }, input, 'chat-image', undefined, { kind: 'chat', sessionId: 'chat' })
  f.runs.finish(run.id, 'completed', null)
  expect(f.artifacts.readForChat(scope, 'chat', image.id).bytes.equals(data)).toBe(true)
  expect(f.artifacts.readForChat(scope, 'chat', image.id).mediaType).toBe('image/png')
  for (const current of [{ ...scope, profileId: 'two' }, { ...scope, principal: { kind: 'user' as const, id: 'bob' } }]) expect(() => f.artifacts.readForChat(current, 'chat', image.id)).toThrow(/unavailable/)
  expect(() => f.artifacts.readForChat(scope, 'other-chat', image.id)).toThrow(/attached/)
  expect(() => f.artifacts.readForChat({ ...scope, sessionId: 'other-chat' }, 'chat', image.id)).toThrow(/scope/)
  f.revoke()
  expect(() => f.artifacts.readForChat(scope, 'chat', image.id)).toThrow(/revoked/)
})
it('detects image type and reads bounded chunks only from the current accepted Run', async () => {
  // Encoding is fixture preparation. An uncompressed PNG keeps the same
  // multi-chunk payload without spending the CI deadline on compression.
  const f = setup(), data = await sharp(randomBytes(512 * 512 * 3), { raw: { width: 512, height: 512, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer()
  expect(data.length).toBeGreaterThan(3 * 192 * 1024)
  const image = await f.artifacts.create(scope, data, new AbortController().signal)
  expect(image).toMatchObject({ mediaType: 'image/png', byteLength: data.length })
  const runScope = f.createRun(image.id), chunks: Buffer[] = []
  let offset = 0
  do {
    const chunk = f.artifacts.read(runScope, image.id, offset)
    expect(chunk.data.length).toBeLessThanOrEqual(262144)
    chunks.push(Buffer.from(chunk.data, 'base64')); offset = chunk.nextOffset
    expect(chunk.done).toBe(offset === data.length)
  } while (offset < data.length)
  // Native byte comparison preserves exact equality without traversing
  // hundreds of thousands of typed-array properties in the assertion library.
  expect(Buffer.concat(chunks).equals(data)).toBe(true)
  expect(() => f.artifacts.read(runScope, image.id, offset)).toThrow(/offset/)
  expect(() => f.artifacts.remove(scope, image.id)).toThrow(/retained/)
  f.runs.finish(runScope.runId, 'completed', null)
  expect(() => f.artifacts.read(runScope, image.id)).toThrow(/live Run/)
})
it('rejects other owners/profiles, unbound reads and images absent from the effective input', async () => {
  const f = setup(), a = await f.artifacts.create(scope, await png(), new AbortController().signal)
  const b = await f.artifacts.create(scope, await png(), new AbortController().signal), runScope = f.createRun(a.id)
  for (const current of [scope, { ...runScope, principal: { kind: 'user' as const, id: 'bob' } }, { ...runScope, profileId: 'two' }]) {
    expect(() => f.artifacts.read(current, a.id)).toThrow(/live Run/)
  }
  expect(() => f.artifacts.read(runScope, b.id)).toThrow(/live Run/)
  expect(() => f.artifacts.validate({ ...scope, profileId: 'two' }, { content: [{ type: 'image', artifactId: a.id, mediaType: a.mediaType }] })).toThrow(/unavailable/)
  expect(() => f.artifacts.validate(scope, { content: [{ type: 'image', artifactId: a.id, mediaType: 'image/jpeg' }] })).toThrow(/media type/)
  f.artifacts.remove(scope, b.id)
  expect(() => f.artifacts.validate(scope, { content: [{ type: 'image', artifactId: b.id, mediaType: b.mediaType }] })).toThrow(/unavailable/)
  f.revoke()
  expect(() => f.artifacts.read(runScope, a.id)).toThrow(/revoked/)
})
it('rejects invalid images, oversized uploads, cancellation and revocation during validation', async () => {
  const f = setup(), signal = new AbortController().signal
  await expect(f.artifacts.create(scope, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'), signal)).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  await expect(f.artifacts.create(scope, Buffer.from('not an image'), signal)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  await expect(f.artifacts.create(scope, Buffer.alloc(MAX_AGENT_IMAGE_BYTES + 1), signal)).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' })
  await expect(f.artifacts.create(scope, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64'), signal)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  const data = await png(), controller = new AbortController()
  const upload = f.artifacts.create(scope, data, controller.signal); controller.abort()
  await expect(upload).rejects.toMatchObject({ code: 'CANCELLED' })
  const revoked = f.artifacts.create(scope, data, signal); f.revoke()
  await expect(revoked).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(f.db.prepare('SELECT count(*) AS count FROM studio_agent_artifacts').get()).toEqual({ count: 0 })
})
it('enforces per-Run and stored-byte quotas before accepting more images', async () => {
  const f = setup(), image = await f.artifacts.create(scope, await png(), new AbortController().signal)
  expect(() => f.artifacts.validate(scope, { content: Array.from({ length: 9 }, () => ({ type: 'image', artifactId: image.id, mediaType: image.mediaType })) })).toThrow(/limit/)
  f.db.prepare('UPDATE studio_agent_artifacts SET byte_length=?').run(4 * 1024 * 1024)
  expect(() => f.artifacts.validate(scope, { content: Array.from({ length: 2 }, () => ({ type: 'image', artifactId: image.id, mediaType: image.mediaType })) })).toThrow(/limit/)
  f.db.prepare('UPDATE studio_agent_artifacts SET byte_length=?').run(64 * 1024 * 1024)
  await expect(f.artifacts.create(scope, await png(), new AbortController().signal)).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' })
})
it('the public context checks cancellation after an asynchronous artifact read', async () => {
  const controller = new AbortController()
  const ctx = createExecutionContext({ ...scope, runId: 'run' }, controller.signal, { info() {}, warn() {}, error() {} }, {
    authorize: async () => {}, sessions: { get: async () => null }, agents: { list: async () => [] },
    artifacts: { read: async () => { controller.abort(); return { id: 'id', mediaType: 'image/png', byteLength: 1, offset: 0, nextOffset: 1, data: 'AA==', done: true } } },
  })
  await expect(ctx.artifacts.read('id')).rejects.toMatchObject({ code: 'CANCELLED' })
})

it('the public SDK reconstructs independently padded chunks and stops on cancellation or invalid progress', async () => {
  const bytes = Buffer.from('图片 bytes 😀'), content = [{ type: 'image' as const, artifactId: 'id', mediaType: 'image/png' }]
  const read = async (id: string, offset = 0): Promise<ArtifactChunk> => {
    const chunk = bytes.subarray(offset, offset + 4), nextOffset = offset + chunk.length
    return { id, mediaType: 'image/png', byteLength: bytes.length, offset, nextOffset, data: chunk.toString('base64'), done: nextOffset === bytes.length }
  }
  const images = await readAgentImages(content, { signal: new AbortController().signal, artifacts: { read } })
  expect(images.get('id')).toEqual({ data: bytes.toString('base64'), mediaType: 'image/png' })
  for (const invalid of [{ nextOffset: 0 }, { done: true }, { mediaType: 'image/jpeg' }, { data: '$secret' }]) {
    await expect(readAgentImages(content, { signal: new AbortController().signal,
      artifacts: { read: async (...args) => ({ ...await read(...args), ...invalid }) } })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  }
  const controller = new AbortController()
  await expect(readAgentImages(content, { signal: controller.signal,
    artifacts: { read: async (...args) => { controller.abort(); return read(...args) } } })).rejects.toMatchObject({ code: 'CANCELLED' })
})
