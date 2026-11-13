import type { Annotation, Box, GradeResult, Question, Word } from './types'

export interface LineBoxWord { index: number; text: string; cx: number; cy: number; w: number; h: number }
export interface LineBox { index: number; text: string; bbox: Box; words: LineBoxWord[] }

/**
 * 把 OCR 词按 y 坐标聚类成一行行，并给出每行的合并像素 bbox。
 * agent 用这个把批改标记（圈选/划线/评语/分数）**锚定到具体文本行**，
 * 而不是凭视觉/猜测估算坐标——这是位置不准的主要根源。
 * 行合并阈值用词高的一半级，容忍手写行内交错。
 */
export function groupLines(words: Word[]): LineBox[] {
  if (!words.length) return []
  const items = words.map((w, index) => ({ w, index })).sort((a, b) => a.w.cy - b.w.cy)
  const lines: { top: number; bottom: number; items: { w: Word; index: number }[] }[] = []
  for (const { w, index } of items) {
    const top = w.cy - w.h / 2
    const bottom = w.cy + w.h / 2
    const line = lines.find(l => !(top > l.bottom + 6 || bottom < l.top - 6))
    if (line) {
      line.top = Math.min(line.top, top)
      line.bottom = Math.max(line.bottom, bottom)
      line.items.push({ w, index })
    } else {
      lines.push({ top, bottom, items: [{ w, index }] })
    }
  }
  return lines
    .map(line => line.items.sort((a, b) => a.w.cx - b.w.cx))
    .map((items, index) => {
      const wordsOut = items.map(({ w, index: i }) => ({ index: i, text: w.text, cx: w.cx, cy: w.cy, w: w.w, h: w.h }))
      const left = Math.min(...items.map(x => x.w.cx - x.w.w / 2))
      const top = Math.min(...items.map(x => x.w.cy - x.w.h / 2))
      const right = Math.max(...items.map(x => x.w.cx + x.w.w / 2))
      const bottom = Math.max(...items.map(x => x.w.cy + x.w.h / 2))
      return { index, text: wordsOut.map(x => x.text).join(' '), bbox: [left, top, right - left, bottom - top] as Box, words: wordsOut }
    })
}

export function wordBox(words: Word[]): Box {
  if (!words.length) throw new Error('Empty annotation word range')
  const left = Math.min(...words.map(w => w.cx - w.w / 2)); const top = Math.min(...words.map(w => w.cy - w.h / 2))
  return [left, top, Math.max(...words.map(w => w.cx + w.w / 2)) - left, Math.max(...words.map(w => w.cy + w.h / 2)) - top]
}
/** Ranges use OCR line indices, inclusive start and exclusive end. No model calls. */
export function applyEdits(words: Word[], questions: Question[], results: GradeResult[]): Annotation[] {
  const annotations: Annotation[] = []
  for (const result of results) {
    const question = questions.find(q => q.qid === result.qid)
    if (!question) throw new Error('Unknown question')
    const [x, y, w] = question.bbox
    const add = (kind: string, bbox: Box, content = '') => annotations.push({ id: `${result.qid}-${annotations.length}`, kind, bbox, content })
    add('badge', [x + w - 90, y, 90, 30], `${result.score}/${result.fullMark}`)
    add('comment', [x, y + question.bbox[3], Math.max(w, 200), 40], result.feedback)
    for (const op of result.diffOps) {
      if (op.type === 'delete' || op.type === 'mark') {
        const [start, end] = op.range
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < question.wordRange[0] || end > question.wordRange[1] || end <= start) throw new Error('Invalid edit range')
        add(op.type === 'delete' ? 'cross' : op.mark || 'circle', wordBox(words.slice(start, end)))
      } else if (op.type === 'insert') {
        if (!Number.isInteger(op.after) || op.after < question.wordRange[0] || op.after >= question.wordRange[1]) throw new Error('Invalid insertion anchor')
        const word = words[op.after]!
        add('comment', [word.cx + word.w / 2, word.cy, 200, 30], op.text)
      } else if (op.type === 'comment' || op.type === 'badge') add(op.type, [x, y, 200, 30], op.text || op.content || '')
    }
  }
  return annotations
}
export function summarize(submissions: { results: GradeResult[] }[]) {
  const rows = submissions.filter(s => s.results.length)
  const totals = rows.map(s => s.results.reduce((n, r) => n + r.score, 0))
  const qids = [...new Set(rows.flatMap(s => s.results.map(r => r.qid)))]
  const questionStats = qids.map(qid => {
    const results = rows.flatMap(s => s.results.filter(r => r.qid === qid)); const scores = results.map(r => r.score)
    const wrongCount = results.filter(r => r.score < r.fullMark).length
    return { qid, count: results.length, average: scores.reduce((a, b) => a + b, 0) / scores.length, max: Math.max(...scores), min: Math.min(...scores), wrongCount, rate: wrongCount / results.length }
  })
  return { total: rows.length, average: totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : 0, max: totals.length ? Math.max(...totals) : 0, min: totals.length ? Math.min(...totals) : 0, passRate: rows.length ? rows.filter((s, i) => totals[i]! >= s.results.reduce((n, r) => n + r.fullMark, 0) * 0.6).length / rows.length : 0, questionStats, wrongRank: [...questionStats].sort((a, b) => b.rate - a.rate) }
}
