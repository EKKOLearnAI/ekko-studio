import { writeFile, mkdir, stat } from 'fs/promises'
import path from 'path'
import { logger } from '../../public/logging'

/**
 * 把扫描结果保存到 Hermes workspace（profile 隔离）。
 *
 * 复用 packages/server/src/services/hermes/run-chat/workspace.ts 的
 * `ensureHermesRunWorkspace` / `defaultHermesWorkspace`：扫描产物的归属
 * 与该 profile 的 Hermes Agent 工作目录一致，便于用户让 Agent 后续读取。
 *
 * 文件布局：
 *   <workspace>/scans/<yyyy-mm-dd>/<slug>-<idx>/page-N.jpg
 *                                              page-N.txt
 *                                              manifest.json
 */

export interface ScannerSavePage {
  /** JPEG/PNG 原图二进制。 */
  buffer: Buffer
  mime: string
  /** OCR 文本（可空）。 */
  text?: string
}

export interface ScannerSaveOptions {
  profile: string
  /** 用户指定的子目录名（可选）；留空则自动按时间戳生成。 */
  title?: string
  workspace?: string
}

export interface ScannerSaveResult {
  workspaceDir: string
  directory: string
  files: Array<{ name: string; kind: 'image' | 'text' | 'manifest'; path: string }>
  markdownPath: string
  manifestPath: string
}

function safeSlug(input: string | undefined): string {
  const base = (input || '').toString().trim().toLowerCase()
  const cleaned = base.replace(/[^a-z0-9_\-\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '')
  if (cleaned) return cleaned.slice(0, 48)
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  return `scan-${stamp}`
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10)
}

function mimeExt(mime: string): string {
  if (mime === 'image/png') return 'png'
  if (mime === 'image/webp') return 'webp'
  return 'jpg'
}

export async function saveScannerPages(
  pages: ScannerSavePage[],
  options: ScannerSaveOptions,
): Promise<ScannerSaveResult> {
  if (!Array.isArray(pages) || pages.length === 0) {
    const err: any = new Error('scanner: no pages to save')
    err.status = 400
    err.code = 'scanner_no_pages'
    throw err
  }
  const { ensureHermesRunWorkspace } = await import('../chat-run/workspace')
  const workspaceDir = await ensureHermesRunWorkspace(options.profile, options.workspace)

  const dateStamp = todayStamp()
  const slug = safeSlug(options.title)
  const targetDir = path.join(workspaceDir, 'scans', dateStamp, slug)

  // 防止并发写入同一目录：用 mkdir recursive 让重复创建幂等
  await mkdir(targetDir, { recursive: true })

  const files: ScannerSaveResult['files'] = []
  const markdownParts: string[] = [`# ${options.title || slug}`, '', `_导出时间：${new Date().toISOString()}_`, '']

  for (const [idx, page] of pages.entries()) {
    const pageNo = String(idx + 1).padStart(2, '0')
    const ext = mimeExt(page.mime || 'image/jpeg')
    const imageName = `page-${pageNo}.${ext}`
    const textName = `page-${pageNo}.txt`
    const imagePath = path.join(targetDir, imageName)
    const textPath = path.join(targetDir, textName)
    await writeFile(imagePath, page.buffer)
    files.push({ name: imageName, kind: 'image', path: imagePath })
    const text = (page.text || '').trim()
    if (text) {
      await writeFile(textPath, `${text}\n`, 'utf-8')
      files.push({ name: textName, kind: 'text', path: textPath })
    }
    markdownParts.push(`## 第 ${idx + 1} 页`, '', `![第 ${idx + 1} 页](./${imageName})`, '')
    if (text) {
      markdownParts.push('**OCR 文本：**', '', '```text', text, '```', '')
    }
  }

  const manifest = {
    title: options.title || slug,
    profile: options.profile,
    workspace: workspaceDir,
    savedAt: new Date().toISOString(),
    pages: pages.map((page, idx) => ({
      index: idx + 1,
      image: files.find(f => f.kind === 'image' && f.name === `page-${String(idx + 1).padStart(2, '0')}.${mimeExt(page.mime || 'image/jpeg')}`)?.path,
      text: page.text?.trim() ? files.find(f => f.kind === 'text' && f.name === `page-${String(idx + 1).padStart(2, '0')}.txt`)?.path : null,
      mime: page.mime || 'image/jpeg',
      hasText: Boolean(page.text?.trim()),
    })),
  }
  const manifestPath = path.join(targetDir, 'manifest.json')
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
  files.push({ name: 'manifest.json', kind: 'manifest', path: manifestPath })

  const markdownPath = path.join(targetDir, 'scan.md')
  await writeFile(markdownPath, markdownParts.join('\n'), 'utf-8')
  files.push({ name: 'scan.md', kind: 'manifest', path: markdownPath })

  // 防呆：写完后 stat 一下确保至少有一张图真实落盘
  await stat(files.find(f => f.kind === 'image')!.path)

  logger.info(
    { profile: options.profile, dir: targetDir, pages: pages.length },
    '[scanner] saved scan pages to workspace',
  )

  return { workspaceDir, directory: targetDir, files, markdownPath, manifestPath }
}
