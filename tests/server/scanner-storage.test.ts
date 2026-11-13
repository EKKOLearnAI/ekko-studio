import '../../packages/server/src/bootstrap/agent-profile-adapter'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveScannerPages } from '../../packages/server/src/modules/studio/services/scanner/storage'

const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAr/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AB//Z',
  'base64',
)

let workspaceDir: string

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), 'scanner-storage-'))
  // workspace 参数传绝对路径，避免依赖 hermes profile 路径
  vi.spyOn(process, 'cwd').mockReturnValue(workspaceDir)
})

afterEach(async () => {
  await rm(workspaceDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('scanner storage', () => {
  it('rejects empty pages', async () => {
    await expect(
      saveScannerPages([], { profile: 'default', workspace: workspaceDir }),
    ).rejects.toMatchObject({ code: 'scanner_no_pages' })
  })

  it('writes images, text sidecars, manifest and markdown summary', async () => {
    const result = await saveScannerPages(
      [
        { buffer: TINY_JPEG, mime: 'image/jpeg', text: '第一页 OCR 文本\nLine 2' },
        { buffer: TINY_JPEG, mime: 'image/jpeg', text: '第二页' },
      ],
      {
        profile: 'default',
        title: '测试文档',
        workspace: workspaceDir,
      },
    )
    expect(result.directory.startsWith(workspaceDir)).toBe(true)
    // 路径分隔符平台相关（POSIX "/" vs Windows "\"），按路径段断言
    expect(result.directory.split(/[\\/]/)).toContain('scans')
    const imageFiles = result.files.filter(f => f.kind === 'image')
    const textFiles = result.files.filter(f => f.kind === 'text')
    expect(imageFiles).toHaveLength(2)
    expect(textFiles).toHaveLength(2)
    expect(result.files.some(f => f.name === 'manifest.json')).toBe(true)
    expect(result.files.some(f => f.name === 'scan.md')).toBe(true)

    // 至少一张图的字节必须真实落盘
    const onDisk = await readFile(imageFiles[0]!.path)
    expect(onDisk.equals(TINY_JPEG)).toBe(true)

    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf-8'))
    expect(manifest.pages).toHaveLength(2)
    expect(manifest.title).toBe('测试文档')

    const markdown = await readFile(result.markdownPath, 'utf-8')
    expect(markdown).toContain('# 测试文档')
    expect(markdown).toContain('第一页 OCR 文本')
    expect(markdown).toContain('第二页')
  })

  it('omits text sidecar when OCR text is empty', async () => {
    const result = await saveScannerPages(
      [{ buffer: TINY_JPEG, mime: 'image/jpeg' }],
      { profile: 'default', title: 'no-text', workspace: workspaceDir },
    )
    expect(result.files.some(f => f.kind === 'text')).toBe(false)
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf-8'))
    expect(manifest.pages[0].text).toBeNull()
  })

  it('auto-generates a slug when title is missing', async () => {
    const result = await saveScannerPages(
      [{ buffer: TINY_JPEG, mime: 'image/jpeg' }],
      { profile: 'default', workspace: workspaceDir },
    )
    expect(result.directory).toMatch(/scan-\d+$/)
  })
})
