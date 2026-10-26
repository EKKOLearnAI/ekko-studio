import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let uploadRoot = ''

vi.mock('../../packages/server/src/modules/studio/services/files/upload-paths', () => ({
  getProfileUploadDir: (profile: string) => join(uploadRoot, profile),
}))

describe('App chunked uploads', () => {
  beforeEach(async () => {
    uploadRoot = await mkdtemp(join(tmpdir(), 'hermes-app-upload-'))
  })

  afterEach(async () => {
    await rm(uploadRoot, { recursive: true, force: true })
  })

  it('writes ordered byte chunks and completes to a profile upload path', async () => {
    const { appendAppUploadChunk, completeAppUpload, openAppUpload } = await import(
      '../../packages/server/src/modules/studio/services/files/app-upload'
    )
    const id = 'upload_test_1234'
    await openAppUpload({ id, owner: '7', profile: 'default', name: 'photo.png', size: 5 })
    await expect(appendAppUploadChunk({
      id,
      owner: '7',
      profile: 'default',
      offset: 0,
      bytes: Uint8Array.from([1, 2, 3]),
    })).resolves.toMatchObject({ nextOffset: 3, done: false })
    await expect(appendAppUploadChunk({
      id,
      owner: '7',
      profile: 'default',
      offset: 3,
      bytes: Uint8Array.from([4, 5]),
    })).resolves.toMatchObject({ nextOffset: 5, done: true })

    const completed = await completeAppUpload({ id, owner: '7', profile: 'default' })
    expect(completed.name).toBe('photo.png')
    expect(completed.path).toMatch(/default[/\\][^/\\]+\.png$/)
    expect(await readFile(completed.path)).toEqual(Buffer.from([1, 2, 3, 4, 5]))
  })

  it('rejects out-of-order chunks and oversized files', async () => {
    const { APP_UPLOAD_MAX_BYTES, appendAppUploadChunk, openAppUpload } = await import(
      '../../packages/server/src/modules/studio/services/files/app-upload'
    )
    await expect(openAppUpload({
      id: 'upload_too_large',
      owner: '7',
      profile: 'default',
      name: 'large.bin',
      size: APP_UPLOAD_MAX_BYTES + 1,
    })).rejects.toMatchObject({ code: 'upload_too_large', status: 413 })

    const id = 'upload_order_123'
    await openAppUpload({ id, owner: '7', profile: 'default', name: 'small.bin', size: 2 })
    await expect(appendAppUploadChunk({
      id,
      owner: '7',
      profile: 'default',
      offset: 1,
      bytes: Uint8Array.from([1]),
    })).rejects.toMatchObject({ code: 'invalid_upload_offset', status: 409 })
  })
})
