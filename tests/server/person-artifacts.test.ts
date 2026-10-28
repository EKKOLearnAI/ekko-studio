import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

let dir: string
const records = vi.hoisted(() => ({ workspace: '', owner: 1, output: 'result '.repeat(1000) }))
vi.mock('../../packages/server/src/modules/studio/repositories/person-store', () => ({
  getPersonExecution: (owner: number) => {
    if (owner !== records.owner) throw new Error('Execution not found')
    return { task_id: 'task', output: records.output }
  },
  getPersonTask: () => ({ workspace: records.workspace }),
}))
import { readPersonArtifact } from '../../packages/server/src/modules/studio/services/person/tools'

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'person-artifact-')))
  records.workspace = dir
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

it('returns a screenshot reference without decoding PNG bytes as text, including large screenshots', async () => {
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#f9ad42' } }).png().toBuffer()
  for (const size of [png.length, 1_939_459, 3_000_000]) {
    const image = Buffer.alloc(size); png.copy(image)
    const path = join(dir, 'desktop screenshot.png')
    await writeFile(path, image)
    const result = await readPersonArtifact(1, 'execution', path)
    expect(result).toMatchObject({ path: 'desktop screenshot.png', absolute_path: path, kind: 'image', media_type: 'image/png', size, next_offset: null })
    expect(result).not.toHaveProperty('content')
    expect(JSON.stringify(result).length).toBeLessThan(1000)
  }
})

it.each([
  ['renamed.txt', Buffer.from([0x00, 0x41, 0x42])],
  ['invalid-utf8.txt', Buffer.from([0xff, 0xfe, 0x41])],
  ['control.txt', Buffer.from([0x01, 0x02, 0x03])],
  ['document.pdf', Buffer.from('%PDF-1.7\n')],
] as const)('keeps non-text artifact %s out of model text', async (name, bytes) => {
  await writeFile(join(dir, name), bytes)
  const result = await readPersonArtifact(1, 'execution', name)
  expect(result).toMatchObject({ absolute_path: join(dir, name), size: bytes.length, next_offset: null })
  expect(result).not.toHaveProperty('content')
})

it('preserves text and output pagination, including Unicode and empty files', async () => {
  const text = '中文🙂\t\r\n'.repeat(1000)
  await writeFile(join(dir, 'report.txt'), text)
  const first = await readPersonArtifact(1, 'execution', 'report.txt')
  const last = await readPersonArtifact(1, 'execution', 'report.txt', 6000)
  expect(first).toMatchObject({ content: text.slice(0, 6000), next_offset: 6000 })
  expect(last).toMatchObject({ content: text.slice(6000), next_offset: null })
  expect(await readPersonArtifact(1, 'execution', '', 6000)).toEqual({ content: records.output.slice(6000), next_offset: null })
  await writeFile(join(dir, 'empty.txt'), '')
  expect(await readPersonArtifact(1, 'execution', 'empty.txt')).toMatchObject({ content: '', next_offset: null })
})

it('enforces ownership and workspace boundaries for file references as well as text', async () => {
  await writeFile(join(dir, 'image.png'), Buffer.from('image'))
  await expect(readPersonArtifact(2, 'execution', 'image.png')).rejects.toThrow('not found')
  records.workspace = ''
  await expect(readPersonArtifact(1, 'execution', 'image.png')).rejects.toThrow('workspace')
  records.workspace = dir
  await symlink(join(dir, '..'), join(dir, 'outside'))
  await expect(readPersonArtifact(1, 'execution', '..')).rejects.toThrow('outside')
  await expect(readPersonArtifact(1, 'execution', 'outside')).rejects.toThrow('outside')
  await expect(readPersonArtifact(1, 'execution', '.')).rejects.toThrow('file')
})
