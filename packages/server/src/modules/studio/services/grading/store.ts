import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { getProfilesBaseDir } from '../../public/profile-config'
import type { Submission } from './types'

/**
 * 批改存储：复用 Hermes Web UI 的 profile 工作区，**不建 SQL 表**。
 *
 * 每张扫描稿落成一个文件组（老师可随时到工作区里查看/导出）：
 *   <workspace>/grading/
 *     images/<scanId>.<ext>     ← 原图
 *     <scanId>.json             ← OCR / 题目 / 评分 / 批注 / 状态等元数据
 *     settings.json             ← OCR 模型 / 评分模型 / 复核阈值
 *
 * 元数据 JSON 里只存 imagePath，不重复内嵌 base64；读取时再从图片文件还原成
 * data URL 供 OCR / 前端使用。班级/考试 SQL 先不用，因此全部就是「工作区里的
 * 一张张扫描稿」。目录直接按 profile 名构造，避免 getProfileDir 对「未创建
 * 目录的 profile」回退到同一根目录导致互相串数据。
 */

export function gradingDirectory(profile: string): string {
  const name = String(profile || 'default').trim() || 'default'
  const base = getProfilesBaseDir()
  const workspace = name === 'default'
    ? join(base, 'workspace')
    : join(base, 'profiles', name, 'workspace')
  const dir = join(workspace, 'grading')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

function imagesDirectory(profile: string): string {
  const dir = join(gradingDirectory(profile), 'images')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

function metadataPath(profile: string, id: string): string {
  return join(gradingDirectory(profile), `${id}.json`)
}

function imageExtension(mime: string): string {
  if (mime === 'image/png') return 'png'
  if (mime === 'image/webp') return 'webp'
  return 'jpg'
}

function mimeFromExtension(ext: string): string {
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  return 'image/jpeg'
}

function writeImage(profile: string, id: string, dataUrl: string): string {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(String(dataUrl || '').trim())
  if (!match) fail('Invalid image data')
  const mime = match[1]!.toLowerCase()
  const buffer = Buffer.from(match[2]!, 'base64')
  if (buffer.length === 0) fail('Invalid image data')
  const ext = imageExtension(mime)
  const target = join(imagesDirectory(profile), `${id}.${ext}`)
  writeFileSync(target, buffer)
  return target
}

function imageDataUrlFromFile(imagePath: string): string {
  if (!imagePath || !existsSync(imagePath)) return ''
  const ext = imagePath.split('.').pop() || 'jpg'
  return `data:${mimeFromExtension(ext)};base64,${readFileSync(imagePath).toString('base64')}`
}

export function fail(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status })
}

export function requiredText(value: unknown, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('Invalid or missing text')
  return value.trim()
}

/** 列出一个 profile 工作区里所有扫描稿的元数据（不含图片本体）。 */
export function listScans(profile: string): Omit<Submission, 'image'>[] {
  const dir = gradingDirectory(profile)
  const entries = readdirSync(dir).filter(file => file.endsWith('.json') && file !== 'settings.json')
  return entries.map(file => {
    const saved = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>
    const { image: _image, imagePath: _path, ...rest } = saved as any
    return rest as Omit<Submission, 'image'>
  }).sort((a, b) => (Number((b as any)?.createdAt) || 0) - (Number((a as any)?.createdAt) || 0))
}

export function readSubmission(profile: string, id: string): Submission {
  const file = metadataPath(profile, id)
  if (!existsSync(file)) fail('Submission not found', 404)
  const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  const { imagePath, ...rest } = saved as any
  const image = imageDataUrlFromFile(String(imagePath || ''))
  if (!image) fail('Submission image missing', 404)
  return { ...rest, image } as Submission
}

export function saveSubmission(profile: string, submission: Submission) {
  const id = submission.id || randomUUID()
  const imagePath = writeImage(profile, id, submission.image)
  const { image: _image, ...rest } = submission
  writeFileSync(metadataPath(profile, id), JSON.stringify({ ...rest, id, imagePath }, null, 2))
}

export function deleteSubmission(profile: string, id: string) {
  const file = metadataPath(profile, id)
  if (!existsSync(file)) fail('Submission not found', 404)
  rmSync(file, { force: true })
  const imageDir = imagesDirectory(profile)
  for (const entry of readdirSync(imageDir)) {
    if (entry.startsWith(`${id}.`)) rmSync(join(imageDir, entry), { force: true })
  }
}

export function readSettings(profile: string): Record<string, any> {
  const defaults = { enabled: false, ocrModel: 'qwen3.5-ocr', visionModel: 'qwen3.7-flash', model: 'qwen3.7-plus', threshold: 0.7 }
  const file = join(gradingDirectory(profile), 'settings.json')
  if (!existsSync(file)) return defaults
  try {
    return { ...defaults, ...JSON.parse(readFileSync(file, 'utf8')) }
  } catch {
    return defaults
  }
}

export function writeSettings(profile: string, input: any) {
  const settings = { ...readSettings(profile) }
  if (typeof input.enabled === 'boolean') settings.enabled = input.enabled
  for (const key of ['ocrModel', 'visionModel', 'model']) if (input[key] !== undefined) settings[key] = requiredText(input[key])
  if (input.threshold !== undefined) {
    if (typeof input.threshold !== 'number' || input.threshold < 0 || input.threshold > 1) fail('Invalid confidence threshold')
    settings.threshold = input.threshold
  }
  writeFileSync(join(gradingDirectory(profile), 'settings.json'), JSON.stringify(settings, null, 2))
  return settings
}
