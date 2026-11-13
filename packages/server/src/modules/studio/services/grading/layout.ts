import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { gradingDirectory } from './store'
import type { Submission, Question } from './types'
import { wordBox } from './annotation-engine'

interface Template {
  width: number
  height: number
  questions: { qid: string; bbox: [number, number, number, number]; fullMark: number; heading: string }[]
}

/**
 * 同卷题号坐标模板复用（无 SQL）。
 *
 * 模板按一个布局键存成文件；当前 UI 暂不建班级/考试，因此统一用 `_default_`
 * 键。`reuseLayout` 会校验扫描件纵横比 + 每题首个 OCR 词与模板 heading 是否
 * 一致，不一致就返回 null（安全回退为重新检测），不会把不同试卷套到同一模板。
 */
function templatePath(profile: string, key: string): string {
  return join(gradingDirectory(profile), `layout-${key}.json`)
}

export function reuseLayout(profile: string, s: Submission): Question[] | null {
  const key = s.examId || '_default_'
  const file = templatePath(profile, key)
  if (!existsSync(file)) return null
  const template: Template = JSON.parse(readFileSync(file, 'utf8'))
  if (Math.abs(template.width / template.height - s.width / s.height) > .03) return null
  const assigned = new Set<number>()
  const questions: Question[] = []
  for (const q of template.questions) {
    const [x, y, w, h] = q.bbox
    const indices = s.words.map((word, index) => ({ word, index })).filter(({ word }) => word.cx / s.width >= x && word.cx / s.width <= x + w && word.cy / s.height >= y && word.cy / s.height <= y + h).map(({ index }) => index)
    if (!indices.length || indices.some(i => assigned.has(i)) || indices.at(-1)! - indices[0]! + 1 !== indices.length) return null
    const selected = s.words.slice(indices[0], indices.at(-1)! + 1)
    if (!selected[0]!.text.startsWith(q.heading)) return null
    indices.forEach(i => assigned.add(i))
    questions.push({ qid: q.qid, fullMark: q.fullMark, bbox: wordBox(selected), wordRange: [indices[0]!, indices.at(-1)! + 1], text: selected.map(w => w.text).join('\n') })
  }
  return assigned.size === s.words.length ? questions : null
}

export function saveLayout(profile: string, s: Submission) {
  const key = s.examId || '_default_'
  const template: Template = {
    width: s.width,
    height: s.height,
    questions: s.questions.map(q => ({
      qid: q.qid,
      fullMark: q.fullMark,
      bbox: [q.bbox[0] / s.width, q.bbox[1] / s.height, q.bbox[2] / s.width, q.bbox[3] / s.height],
      heading: s.words[q.wordRange[0]]!.text.slice(0, 12),
    })),
  }
  writeFileSync(templatePath(profile, key), JSON.stringify(template))
}
