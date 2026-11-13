import sharp from 'sharp'
import type { Annotation } from './types'

/**
 * 服务端把「原图 + 批改批注」渲染成一张 PNG，供 agent loop 使用：
 *   grading_preview -> 返回当前批改痕迹的预览图（agent 用视觉模型检查位置/遮挡）
 * agent 不画独立图片，而是用 grading_add_annotation / grading_apply_edits 写批注，
 * 再调 grading_preview 看效果、用 vision 校验、逐个修改。
 *
 * 说明：这里用 SVG 叠加 + sharp 合成（服务端无 DOM）；字体受服务器可用系统字体限制，
 * 位置/配色/虚线效果是准的。客户端预览以渲染器为准。
 */

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function wrapText(text: string, maxChars: number): string[] {
  const out: string[] = []
  for (const para of String(text || '').split('\n')) {
    let line = ''
    for (const ch of para) {
      if (line.length >= maxChars) { out.push(line); line = ch } else line += ch
    }
    out.push(line)
  }
  return out
}

function badgeColor(content: string, fallback: string): string {
  const m = /^\s*(\d+)\s*\/\s*(\d+)/.exec(content || '')
  if (!m) return fallback
  const score = Number(m[1]); const full = Number(m[2])
  if (full <= 0) return fallback
  if (score >= full) return '#16a34a'
  if (score <= 0) return '#dc2626'
  return '#d97706'
}

/** 把批注转成 SVG 覆盖层（宽度/高度 = 原图尺寸）。 */
export function annotationsToSvg(annotations: Annotation[], width: number, height: number, handDrawn: boolean): string {
  const baseDash = handDrawn ? '10 7' : '7 5'
  const parts: string[] = []
  for (const a of annotations) {
    const [x, y, w, h] = a.bbox
    const color = a.color || '#dc2626'
    const sw = a.width || 3
    const dash = a.solid ? 'none' : baseDash
    const font = esc(a.fontFamily || (handDrawn ? '"Kaiti SC","KaiTi","kaiti","cursive",serif' : 'sans-serif'))

    if (a.kind === 'circle') {
      parts.push(`<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${Math.max(1, w / 2)}" ry="${Math.max(1, h / 2)}" fill="${esc(color)}" fill-opacity="0.1" stroke="${esc(color)}" stroke-width="${sw}" stroke-dasharray="${dash}"/>`)
    } else if (a.kind === 'cross') {
      parts.push(`<line x1="${x}" y1="${y}" x2="${x + w}" y2="${y + h}" stroke="${esc(color)}" stroke-width="${sw}" stroke-dasharray="${dash}"/><line x1="${x + w}" y1="${y}" x2="${x}" y2="${y + h}" stroke="${esc(color)}" stroke-width="${sw}" stroke-dasharray="${dash}"/>`)
    } else if (a.kind === 'underline') {
      parts.push(`<line x1="${x}" y1="${y + h}" x2="${x + w}" y2="${y + h}" stroke="${esc(color)}" stroke-width="${sw}" stroke-dasharray="${dash}"/>`)
    } else if (a.kind === 'pen' && a.points && a.points.length >= 2) {
      const pts = a.points.map(n => Math.round(n)).join(',')
      parts.push(`<polyline points="${pts}" fill="none" stroke="${esc(color)}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="none"/>`)
    } else if (a.kind === 'badge') {
      const text = esc(String(a.content || '').slice(0, 40))
      const chip = badgeColor(a.content || '', color)
      parts.push(`<g><rect x="${x}" y="${y}" width="${Math.max(30, (a.content || '').length * 14 + 14)}" height="26" rx="6" fill="${esc(chip)}" fill-opacity="0.18" stroke="${esc(chip)}" stroke-width="1.5" stroke-dasharray="${dash}"/><text x="${x + 8}" y="${y + 18}" font-family="${font}" font-size="16" fill="${esc(chip)}">${text}</text></g>`)
    } else {
      // comment：紧凑手写便签
      const lines = wrapText(a.content || '', 12).slice(0, 6)
      const boxW = Math.min(200, Math.max(40, ...lines.map(l => l.length * 14 + 18)))
      const boxH = 12 + lines.length * 22
      const chip = a.color || '#0f172a'
      parts.push(`<g><rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="7" fill="${esc(chip)}" fill-opacity="0.82" stroke="${esc(chip)}" stroke-width="1.5" stroke-dasharray="${dash}"/>` + lines.map((ln, i) => `<text x="${x + 9}" y="${y + 20 + i * 22}" font-family="${font}" font-size="15" fill="#fff">${esc(ln)}</text>`).join('') + `</g>`)
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">${parts.join('')}</svg>`
}

/** 合成「原图 + 批改痕迹」为 PNG，返回 dataURL。 */
export async function renderPreviewPng(dataUrl: string, annotations: Annotation[], handDrawn = true): Promise<{ image: string; width: number; height: number }> {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl || '')
  if (!match) throw new Error('Invalid image')
  const buffer = Buffer.from(match[2]!, 'base64')
  const meta = await sharp(buffer, { limitInputPixels: 30_000_000 }).metadata()
  const width = meta.width || 1
  const height = meta.height || 1
  const svg = Buffer.from(annotationsToSvg(annotations, width, height, handDrawn))
  const out = await sharp(buffer, { limitInputPixels: 30_000_000 })
    .composite([{ input: svg, top: 0, left: 0 }])
    .png()
    .toBuffer({ resolveWithObject: true })
  return { image: `data:image/png;base64,${out.data.toString('base64')}`, width: out.info.width, height: out.info.height }
}
