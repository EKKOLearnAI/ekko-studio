import { requestClient, completeClientRequest } from '../services/grading/client-requests'
import type { Context } from 'koa'
import { deleteSubmission, fail, listScans, readSettings, readSubmission, requiredText, saveSubmission, writeSettings } from '../services/grading/store'
import { capture, step, validateResults } from '../services/grading/pipeline'
import { groupLines, summarize } from '../services/grading/annotation-engine'
import { renderPreviewPng } from '../services/grading/render-preview'
import type { Annotation, Box } from '../services/grading/types'
import sharp from 'sharp'
import { randomUUID } from 'node:crypto'

const ALLOWED_ANNOTATION_KINDS = ['badge', 'comment', 'circle', 'cross', 'underline', 'pen'] as const

/**
 * 容错地把 bbox 转成 4 元数字框。agent 经 MCP 工具传参时，bbox 可能是：
 *   [540,580,220,130]        —— 数字数组
 *   ["540","580","220","130"] —— 数字字符串数组
 *   [[540,580,220,130]]      —— 框架再包一层（嵌套）
 * 这里统一展平/转数字，避免 "Invalid annotation bbox" 导致批注写不回去、预览不更新。
 */
function toBox(value: any): Box | null {
  if (!Array.isArray(value)) return null
  let arr = value
  if (arr.length === 1 && Array.isArray(arr[0])) arr = arr[0]
  if (arr.length !== 4) return null
  const nums = arr.map((n: any) => (typeof n === 'number' ? n : Number(n)))
  if (nums.some(n => !Number.isFinite(n))) return null
  return nums as Box
}

/** 校验并归一化一条批注（供 agent 以工具方式添加/修改批注）。 */
function validateAnnotation(spec: any): Annotation {
  if (!spec || typeof spec !== 'object') fail('Invalid annotation')
  const { id, kind, content } = spec
  if (typeof id !== 'string' || !id) fail('Invalid annotation id')
  if (!ALLOWED_ANNOTATION_KINDS.includes(kind)) fail('Invalid annotation kind')
  if (typeof content !== 'string' || content.length > 5000) fail('Invalid annotation content')
  const bbox = toBox(spec.bbox)
  if (!bbox) fail('Invalid annotation bbox')
  const annotation: Annotation = { id, kind, bbox, content }
  if (typeof spec.color === 'string' && spec.color.length <= 32) annotation.color = spec.color
  if (Number.isFinite(spec.width)) annotation.width = spec.width as number
  if (typeof spec.fontFamily === 'string' && spec.fontFamily.length <= 80) annotation.fontFamily = spec.fontFamily
  if (spec.solid === true) annotation.solid = true
  if (spec.points != null) {
    let pts = spec.points
    if (Array.isArray(pts) && pts.length > 1 && Array.isArray(pts[0])) pts = pts[0]
    if (!Array.isArray(pts) || pts.length > 20000) fail('Invalid annotation points')
    const nums = pts.map((n: any) => (typeof n === 'number' ? n : Number(n)))
    if (nums.some(n => !Number.isFinite(n))) fail('Invalid annotation points')
    annotation.points = nums as number[]
  }
  return annotation
}

/**
 * 供 agent/AI 读取扫描件图片：把原图缩到 1600px 内并压成 JPEG，避免超大
 * base64 撑爆视觉上下文。返回 `{ image, mimeType, width, height }`。
 */
async function renderViewImage(profile: string, scanId: string) {
  const s = readSubmission(profile, requiredText(scanId))
  const match = /^data:([^;]+);base64,(.+)$/i.exec(s.image || '')
  if (!match) fail('Submission image missing', 404)
  const buffer = Buffer.from(match[2]!, 'base64')
  const maxEdge = 1600
  const out = await sharp(buffer, { limitInputPixels: 30_000_000 })
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer({ resolveWithObject: true })
  return {
    image: `data:image/jpeg;base64,${out.data.toString('base64')}`,
    mimeType: 'image/jpeg',
    width: out.info.width,
    height: out.info.height,
  }
}

/** 添加 / 修改 / 删除一条批注；返回最新批注列表与 revision。 */
function annotate(profile: string, args: any) {
  const s = readSubmission(profile, requiredText(args.scanId))
  const annotationId = typeof args.annotationId === 'string' ? args.annotationId : ''
  let annotations = Array.isArray(s.annotations) ? s.annotations.map(a => ({ ...a })) : []
  if (args.remove === true) {
    if (!annotationId) fail('annotationId is required to remove')
    if (!annotations.some(a => a.id === annotationId)) fail('Annotation not found', 404)
    annotations = annotations.filter(a => a.id !== annotationId)
  } else if (annotationId) {
    const target = annotations.find(a => a.id === annotationId)
    if (!target) fail('Annotation not found', 404)
    const next = validateAnnotation({
      id: target.id,
      kind: args.kind ?? target.kind,
      bbox: args.bbox ?? target.bbox,
      content: args.content ?? target.content,
      color: args.color ?? target.color,
      width: args.width ?? target.width,
      points: args.points ?? target.points,
    })
    annotations = annotations.map(a => (a.id === annotationId ? next : a))
  } else {
    const next = validateAnnotation({
      id: randomUUID(),
      kind: args.kind,
      bbox: args.bbox,
      content: typeof args.content === 'string' ? args.content : '',
      color: args.color,
      width: args.width,
      points: args.points,
    })
    annotations.push(next)
  }
  s.annotations = annotations
  s.revision++
  saveSubmission(profile, s)
  return { revision: s.revision, annotations }
}

/** 批量添加多条批注（agent loop 用：一次成批 + 用 preview 校验后逐个调）。 */
function addAnnotations(profile: string, args: any) {
  const s = readSubmission(profile, requiredText(args.scanId))
  if (!Array.isArray(args.annotations) || args.annotations.length > 200) fail('Invalid annotations')
  let annotations = Array.isArray(s.annotations) ? s.annotations.map(a => ({ ...a })) : []
  for (const spec of args.annotations) {
    const next = validateAnnotation({
      id: randomUUID(),
      kind: spec?.kind,
      bbox: spec?.bbox,
      content: typeof spec?.content === 'string' ? spec.content : '',
      color: spec?.color,
      width: spec?.width,
      points: spec?.points,
      fontFamily: spec?.fontFamily,
      solid: spec?.solid,
    })
    annotations.push(next)
  }
  s.annotations = annotations
  s.revision++
  saveSubmission(profile, s)
  return { revision: s.revision, annotations }
}

/** 把存储的扫描图旋转 90°（改成正向），并清空 OCR/题目/结果/批注，需重新 OCR。 */
async function rotateSubmission(profile: string, args: any) {
  const s = readSubmission(profile, requiredText(args.scanId))
  const dir = args.direction === 'left' ? 'left' : 'right'
  const match = /^data:([^;]+);base64,(.+)$/i.exec(s.image || '')
  if (!match) fail('Submission image missing', 404)
  const buffer = Buffer.from(match[2]!, 'base64')
  const out = await sharp(buffer, { limitInputPixels: 30_000_000 })
    .rotate(dir === 'left' ? -90 : 90)
    .jpeg({ quality: 90 })
    .toBuffer({ resolveWithObject: true })
  s.image = `data:image/jpeg;base64,${out.data.toString('base64')}`
  s.width = out.info.width
  s.height = out.info.height
  s.words = []; s.questions = []; s.results = []; s.annotations = []
  s.status = 'pending'; s.error = ''; s.revision++
  saveSubmission(profile, s)
  return { scanId: s.id, width: s.width, height: s.height, status: 'pending' }
}

function profileFor(ctx: Context) {
  if (!ctx.state.user && !ctx.state.serverTokenAuth) fail('Unauthorized', 401)
  const profile = String(ctx.state.profile?.name || ctx.get('x-hermes-profile') || ctx.query.profile || 'default')
  const user = ctx.state.user
  if (!ctx.state.serverTokenAuth && user?.role !== 'super_admin' && !user?.profiles?.includes(profile)) fail('Profile access denied', 403)
  return profile
}

export async function gradingRequest(ctx: Context) {
  try {
    const profile = profileFor(ctx)
    const action = ctx.params.action
    const args = (ctx.request as any).body || {}
    if (action === 'settings') { ctx.body = ctx.method === 'GET' ? readSettings(profile) : writeSettings(profile, args); return }
    // 批改工具不再用 settings.enabled 硬闸门：profile 已鉴权，且需要客户端会话的动作
    // （capture_scan / render 在不带图时）由 requestClient 在无面板时自行失败。
    // 这样 agent 走 paper-grading 的 grading_* 工具时不会因"插件未启用"被 403，
    // 从而避免 agent 退化为 execute_code / PIL 自行画框。
    // readSettings 仅用于显式开关配置（GET）。
    switch (action) {
      case 'list':
        // 不分班级/考试：列出工作区 grading 文件夹里的全部扫描稿
        ctx.body = listScans(profile); break
      case 'capture_scan': ctx.body = args.image ? await capture(profile, args) : await requestClient(profile, 'capture', { examId: args.examId, pageNumber: args.pageNumber }); break
      case 'client_complete': completeClientRequest(profile, requiredText(args.requestId), args.result); ctx.body = { ok: true }; break
      case 'get': {
        const s = readSubmission(profile, requiredText(args.scanId))
        // agent 读取元数据时省略图片本体，避免超大 base64 撑爆视觉/文本上下文。
        ctx.body = args.omitImage ? (({ image: _image, ...rest }) => rest)(s) : s
        break
      }
      case 'lines': {
        // 给 agent 提供「按行归并的像素 bbox」，让批改标记锚定到具体文本行。
        const s = readSubmission(profile, requiredText(args.scanId))
        if (!s.words.length) fail('Run OCR first (grading_ocr) before reading line boxes', 409)
        ctx.body = { scanId: s.id, width: s.width, height: s.height, lines: groupLines(s.words) }
        break
      }
      case 'view_image': ctx.body = await renderViewImage(profile, requiredText(args.scanId)); break
      case 'preview': {
        // 返回「原图 + 当前批改痕迹」的合成 PNG，供 agent loop 用视觉模型检查位置/遮挡。
        const s = readSubmission(profile, requiredText(args.scanId))
        ctx.body = await renderPreviewPng(s.image, s.annotations || [], args.style !== 'printed')
        break
      }
      case 'add_annotation': ctx.body = annotate(profile, args); break
      case 'add_annotations': ctx.body = addAnnotations(profile, args); break
      case 'rotate': ctx.body = await rotateSubmission(profile, args); break
      case 'delete': deleteSubmission(profile, requiredText(args.scanId)); ctx.body = { ok: true }; break
      case 'summary': {
        if (!Array.isArray(args.scanIds) || args.scanIds.length > 1000) fail('Invalid scan IDs')
        ctx.body = summarize([...new Set<string>(args.scanIds.map((id: unknown) => requiredText(id)))].map(id => readSubmission(profile, id))); break
      }
      case 'review': {
        const s = readSubmission(profile, requiredText(args.scanId))
        if (s.revision !== args.revision) fail('Submission changed; reload before reviewing', 409)
        s.results = validateResults(args.results, s.questions)
        s.status = 'done'; s.revision++; saveSubmission(profile, s); ctx.body = { revision: s.revision }; break
      }
      case 'save_annotations': {
        const s = readSubmission(profile, requiredText(args.scanId))
        if (args.revision !== s.revision) fail('Submission changed; reload before saving', 409)
        if (!Array.isArray(args.annotations) || args.annotations.length > 2000) fail('Invalid annotations')
        const cleaned: Annotation[] = []
        for (const a of args.annotations) {
          if (!a || typeof a.id !== 'string' || !ALLOWED_ANNOTATION_KINDS.includes(a.kind)) fail('Invalid annotation')
          const bbox = toBox(a.bbox)
          if (!bbox) fail('Invalid annotation bbox')
          if (typeof a.content !== 'string' || a.content.length > 5000) fail('Invalid annotation content')
          const boxed: Annotation = { ...a, id: a.id, bbox }
          if (a.points != null && (!Array.isArray(a.points) || a.points.length > 20000 || a.points.some((n: unknown) => typeof n !== 'number' || !Number.isFinite(n)))) fail('Invalid annotation points')
          cleaned.push(boxed)
        }
        s.annotations = cleaned; s.revision++; saveSubmission(profile, s); ctx.body = { revision: s.revision }; break
      }
      case 'render': { const scanId = requiredText(args.scanId); readSubmission(profile, scanId); ctx.body = await requestClient(profile, 'render', { scanId, style: args.style === 'printed' ? 'printed' : 'rough' }); break }
      case 'ocr': case 'detect_questions': case 'grade': case 'apply_edits': ctx.body = await step(profile, requiredText(args.scanId), action, args); break
      default: fail('Unknown grading action', 404)
    }
  } catch (error: any) { ctx.status = error.status || 500; ctx.body = { error: error.message, code: 'grading_error' } }
}
