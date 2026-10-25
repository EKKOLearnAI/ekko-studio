import AdmZip from 'adm-zip'
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentResourceFiles } from '../../packages/server/src/modules/studio/services/agents/resource-files'
import { AgentResourceSkills } from '../../packages/server/src/modules/studio/services/agents/resource-skill-files'
import { copySkillUploads, parseSkillArchive, MAX_SKILL_FILE_BYTES } from '../../packages/server/src/modules/studio/services/agents/resource-skill-archive'
import { parseResourceSkillUpload } from '../../packages/server/src/modules/studio/http/resource-skill-upload'
import { StudioError, type AgentResourceLocations } from '../../packages/studio-plugin-sdk/src'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'resource-skills-中文 ')); roots.push(root)
  const authorize = vi.fn(), locations: AgentResourceLocations = { skills: [
    { id: 'local', name: 'Local', path: join(root, 'skills'), scope: 'scoped', readOnly: false },
    { id: 'shared', name: 'Shared', path: join(root, 'shared'), scope: 'shared', readOnly: true },
  ] }
  const files = new AgentResourceFiles(locations, authorize), skills = new AgentResourceSkills(files, authorize)
  return { root, files, skills, locations, authorize }
}
const uploads = () => [
  { filename: '示例/SKILL.md', data: Buffer.from('# Skill\nUse the local helper.') },
  { filename: '示例/scripts/helper.py', data: Buffer.from('print("hello")') },
  { filename: '示例/assets/binary.bin', data: Buffer.from([0, 255, 8, 128]) },
]
const archive = () => parseSkillArchive(copySkillUploads(uploads()))
const ref = { locationId: 'local', path: '示例' }

it('publishes a complete Skill once, preserves binary assets and removes exactly the reviewed directory', async () => {
  const f = await setup()
  f.skills.import('local', archive())
  expect(await readFile(join(f.root, 'skills/示例/assets/binary.bin'))).toEqual(uploads()[2].data)
  expect((await f.files.list()).map(file => file.path)).toEqual(['示例/assets/binary.bin', '示例/scripts/helper.py', '示例/SKILL.md'])
  expect(() => f.skills.import('local', archive())).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
  expect((await readdir(join(f.root, 'skills')))).toEqual(['示例'])
  await mkdir(join(f.root, 'skills/other')); await writeFile(join(f.root, 'skills/other/SKILL.md'), 'other')
  const review = f.skills.review(ref)
  expect(review).toMatchObject({ ...ref, files: 3, bytes: uploads().reduce((total, file) => total + file.data.length, 0) })
  expect(f.skills.remove(ref, review.etag)).toEqual({ removed: true })
  expect(await readdir(join(f.root, 'skills'))).toEqual(['other'])
})

it('rejects deletion after an asset or hidden file changes while preserving the whole current tree', async () => {
  const f = await setup(); f.skills.import('local', archive())
  const before = f.skills.review(ref)
  await writeFile(join(f.root, 'skills/示例/assets/binary.bin'), 'new asset')
  expect(() => f.skills.remove(ref, before.etag)).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
  const next = f.skills.review(ref)
  await writeFile(join(f.root, 'skills/示例/.native-state'), 'external edit')
  expect(() => f.skills.remove(ref, next.etag)).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
  expect(await readFile(join(f.root, 'skills/示例/SKILL.md'), 'utf8')).toBe(uploads()[0].data.toString())
})

it('protects declared roots, readonly descendants, symlink aliases and revoked callers', async () => {
  const f = await setup(); f.skills.import('local', archive())
  expect(() => f.skills.review({ ...ref, path: '' })).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  expect(() => f.skills.import('shared', archive())).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  f.locations.configs = [{ id: 'protected', name: 'Protected', path: join(f.root, 'skills/示例/scripts/helper.py'), scope: 'builtin', readOnly: true, kind: 'file' }]
  expect(() => f.skills.review(ref)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  delete f.locations.configs
  await symlink(join(f.root, 'skills/示例'), join(f.root, 'skills/alias'), 'dir')
  expect(() => f.skills.review({ ...ref, path: 'alias' })).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  await symlink(join(f.root, 'shared'), join(f.root, 'skills/示例/linked'), 'dir')
  expect(() => f.skills.review(ref)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  f.authorize.mockImplementation(() => { throw new StudioError('FORBIDDEN', 'Revoked') })
  expect(() => f.skills.import('local', { ...archive(), name: 'new' })).toThrow('Revoked')
  expect(await readdir(join(f.root, 'skills'))).toEqual(['alias', '示例'])
})

it('copies upload bytes before asynchronous admission and accepts root or single-folder ZIPs', () => {
  const source = uploads(), copied = copySkillUploads(source)
  source[0].data.fill(0)
  expect(parseSkillArchive(copied).files[0].data.toString()).toContain('# Skill')
  for (const prefix of ['', 'native/']) {
    const zip = new AdmZip(); zip.addFile(prefix + 'SKILL.md', Buffer.from('instructions')); zip.addFile(prefix + 'assets/binary', Buffer.from([0, 255]))
    expect(parseSkillArchive(copySkillUploads([{ filename: 'archive.zip', data: zip.toBuffer() }]))).toMatchObject({ name: prefix ? 'native' : 'archive', files: [
      expect.objectContaining({ path: 'assets/binary', data: Buffer.from([0, 255]) }), expect.objectContaining({ path: 'SKILL.md' }),
    ] })
  }
})

it.each(['../outside/SKILL.md', '/absolute/SKILL.md', 'C:/SKILL.md', 'skill/../../SKILL.md', 'skill\\SKILL.md', 'skill/NUL.txt', 'skill/asset:stream', 'skill/bad./SKILL.md'])('rejects unsafe upload path %s before publication', filename => {
  expect(() => copySkillUploads([{ filename, data: Buffer.from('instructions') }])).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
})

it('rejects archive links, expanded bombs, excessive directory counts and case collisions', () => {
  const zip = new AdmZip(); zip.addFile('SKILL.md', Buffer.from('instructions')); zip.addFile('linked', Buffer.from('/outside')).attr = (0xa1ff << 16) >>> 0
  expect(() => parseSkillArchive(copySkillUploads([{ filename: 'skill.zip', data: zip.toBuffer() }]))).toThrow()
  const bomb = new AdmZip(); bomb.addFile('SKILL.md', Buffer.alloc(MAX_SKILL_FILE_BYTES + 1, 120))
  const forged = bomb.toBuffer(), header = forged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  forged.writeUInt32LE(1, header + 24)
  expect(() => parseSkillArchive(copySkillUploads([{ filename: 'skill.zip', data: forged }]))).toThrow()
  const count = new AdmZip(); count.addFile('SKILL.md', Buffer.from('instructions'))
  const countBytes = count.toBuffer(), end = countBytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  countBytes.writeUInt16LE(600, end + 8); countBytes.writeUInt16LE(600, end + 10)
  expect(() => parseSkillArchive(copySkillUploads([{ filename: 'skill.zip', data: countBytes }]))).toThrow(expect.objectContaining({ code: 'RESOURCE_EXHAUSTED' }))
  expect(() => parseSkillArchive(copySkillUploads([...uploads(), { filename: '示例/assets/BINARY.bin', data: Buffer.from('collision') }]))).toThrow()
})

it('parses binary multipart framing and rejects duplicate authority fields', () => {
  const boundary = 'skill-upload-boundary', binary = Buffer.from('before\r\n--skill-upload-boundaryNOT-A-DELIMITER\0after')
  const part = (name: string, data: Buffer | string, filename?: string) => Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"${filename ? `; filename="${filename}"` : ''}\r\n\r\n`), Buffer.from(data), Buffer.from('\r\n')])
  const fields = [part('revision', '3'), part('snapshot', 'a'.repeat(64)), part('locationId', 'native')]
  const body = Buffer.concat([...fields, part('file', binary, '示例/asset.bin'), Buffer.from(`--${boundary}--\r\n`)])
  expect(parseResourceSkillUpload(`multipart/form-data; boundary="${boundary}"`, body)).toMatchObject({ revision: 3, locationId: 'native', uploads: [{ filename: '示例/asset.bin', data: binary }] })
  expect(() => parseResourceSkillUpload(`multipart/form-data; boundary=${boundary}`, Buffer.concat([part('revision', '2'), body]))).toThrow()
})

it('applies the directory quota to effective ZIP64 counts before allocating entries', () => {
  const zip = new AdmZip(); zip.addFile('SKILL.md', Buffer.from('instructions'))
  const bytes = zip.toBuffer(), end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const record = Buffer.alloc(56), locator = Buffer.alloc(20)
  record.writeUInt32LE(0x06064b50); record.writeBigUInt64LE(44n, 4)
  record.writeBigUInt64LE(600n, 24); record.writeBigUInt64LE(600n, 32)
  record.writeBigUInt64LE(BigInt(bytes.readUInt32LE(end + 12)), 40)
  record.writeBigUInt64LE(BigInt(bytes.readUInt32LE(end + 16)), 48)
  locator.writeUInt32LE(0x07064b50); locator.writeBigUInt64LE(BigInt(end), 8); locator.writeUInt32LE(1, 16)
  const malicious = Buffer.concat([bytes.subarray(0, end), record, locator, bytes.subarray(end)])
  expect(() => parseSkillArchive(copySkillUploads([{ filename: 'skill.zip', data: malicious }]))).toThrow(expect.objectContaining({ code: 'RESOURCE_EXHAUSTED' }))
})

it('rejects raw traversal in ZIP names and encrypted entries before extracting contents', () => {
  const zip = new AdmZip(); zip.addFile('safe/SKILL.md', Buffer.from('instructions'))
  const unsafe = zip.toBuffer(), original = Buffer.from('safe/SKILL.md'), replacement = Buffer.from('../x/SKILL.md')
  for (let offset = unsafe.indexOf(original); offset >= 0; offset = unsafe.indexOf(original, offset + original.length)) replacement.copy(unsafe, offset)
  expect(() => parseSkillArchive(copySkillUploads([{ filename: 'skill.zip', data: unsafe }]))).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  const clean = new AdmZip(); clean.addFile('safe/SKILL.md', Buffer.from('instructions'))
  const encrypted = clean.toBuffer(), central = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  encrypted.writeUInt16LE(encrypted.readUInt16LE(central + 8) | 1, central + 8)
  expect(() => parseSkillArchive(copySkillUploads([{ filename: 'skill.zip', data: encrypted }]))).toThrow(expect.objectContaining({ code: 'CAPABILITY_UNSUPPORTED' }))
})

it.skipIf(process.platform === 'win32')('retains an archived helper owner-execute bit without restoring group, other or special permissions', async () => {
  const f = await setup(), zip = new AdmZip()
  zip.addFile('SKILL.md', Buffer.from('Use scripts/helper.sh'))
  zip.addFile('scripts/helper.sh', Buffer.from('#!/bin/sh\nprintf helper'), '', 0o7755)
  const archive = parseSkillArchive(copySkillUploads([{ filename: 'executable.zip', data: zip.toBuffer() }]))
  f.skills.import('local', archive)
  expect((await stat(join(f.root, 'skills/executable/scripts/helper.sh'))).mode & 0o7777).toBe(0o700)
  expect((await stat(join(f.root, 'skills/executable/SKILL.md'))).mode & 0o777).toBe(0o600)
})
