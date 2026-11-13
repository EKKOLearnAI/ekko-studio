import { getApiKey, getBaseUrl, getActiveProfileName } from '@/api/client'

/**
 * 会议标题自动命名辅助函数（纯函数，便于单测）。
 *
 * 会议模式下，新建会议的默认标题是“会议 + 创建时间”（如“会议 2026/9/1 15:48:27”），
 * 设备端同步的会议可能只有“会议”。AI 分析完成后我们希望用内容生成的新名称替换这类
 * 占位标题，但绝不覆盖用户自己命名的标题。
 */

const PLACEHOLDER_DATE_RE = /^会议\s+\d{4}[\-/.]\d{1,2}[\-/.]\d{1,2}/

/** 是否是系统自动生成的占位标题（应被 AI 命名覆盖）。 */
export function isAutoPlaceholderMeetingTitle(title: string | null | undefined): boolean {
  const t = (title ?? '').trim()
  if (!t) return true
  if (t === '会议') return true
  return PLACEHOLDER_DATE_RE.test(t)
}

/** 该会议是否允许被 AI 自动重命名：占位标题，或此前已由 AI 命名（允许最终报告再修一次）。 */
export function canAutoRenameMeeting(session: {
  title: string
  titleAutoNamed?: boolean
}): boolean {
  if (isAutoPlaceholderMeetingTitle(session.title)) return true
  return session.titleAutoNamed === true
}

/**
 * 清洗 LLM/报告里提取出的标题候选：去 markdown 标记/包裹符/结尾标点，超长截断。
 * 清洗后为空返回 null。
 */
export function sanitizeMeetingTitle(raw: string | null | undefined): string | null {
  const text = String(raw ?? '').trim()
  if (!text) return null
  const cleaned = text
    .replace(/^[#*>\s]+/, '') // markdown 一级标题标记等
    .replace(/^标题[:：]?\s*/, '') // “标题：”
    .replace(/^[「『“‘"《〈(（]+/, '')
    .replace(/[」』”’"》〉)）]+$/, '')
    .replace(/[。．.!！?？]+$/, '')
    .trim()
  if (!cleaned) return null
  return cleaned.length > 30 ? cleaned.slice(0, 30) : cleaned
}

/**
 * 从报告正文里提取会议标题：只认正文最前面出现的 Markdown 一级标题（`# xxx`），
 * 规避把“## 会议摘要”之类的章节标题误当会议名。找不到返回 null。
 */
export function extractMeetingTitleFromReport(reportMarkdown: string | null | undefined): string | null {
  if (!reportMarkdown) return null
  const lines = String(reportMarkdown).split(/\r?\n/)
  let nonEmptySeen = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (nonEmptySeen >= 8) break // 只找正文开头一小段内的标题
    nonEmptySeen++
    const match = trimmed.match(/^#\s+(.+)$/)
    if (match) {
      const title = sanitizeMeetingTitle(match[1])
      if (title) return title
    }
  }
  return null
}

/** 把句子转成供 AI 命名使用的转写文本（复用格式：带说话人标注）。 */
export function formatTranscriptForTitle(sentences: Array<{ text?: string; speaker?: string }>): string {
  return (sentences || [])
    .map((s) => `${s.speaker ? `[${s.speaker}] ` : ''}${s.text ?? ''}`)
    .filter((line) => line.trim())
    .join('\n')
}

/**
 * 向服务端请求一个 AI 生成的会议标题（轻量、一次）。失败返回 null，绝不抛错。
 */
export async function requestAiMeetingTitle(transcript: string): Promise<string | null> {
  if (!transcript || !transcript.trim()) return null
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const profile = getActiveProfileName()
    if (profile) headers['X-Hermes-Profile'] = profile
    const apiKey = getApiKey()
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
    const response = await fetch(`${getBaseUrl()}/api/studio/meeting-asr/title`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ transcript }),
    })
    if (!response.ok) return null
    const data = await response.json().catch(() => null)
    const title = sanitizeMeetingTitle((data as any)?.title)
    return title
  } catch {
    return null
  }
}
