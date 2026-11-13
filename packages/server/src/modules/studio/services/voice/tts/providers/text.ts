const DEFAULT_MAX_TTS_CHARS = 1500

const HIDDEN_REASONING_BLOCK_RE = /<(think|thinking)\b[^>]*>[\s\S]*?<\/\1>/gi
const UNCLOSED_HIDDEN_REASONING_BLOCK_RE = /<(think|thinking)\b[^>]*>[\s\S]*/gi
const FENCED_CODE_BLOCK_RE = /```[\s\S]*?```/g
const UNCLOSED_FENCED_CODE_BLOCK_RE = /```[\s\S]*/g
const INLINE_CODE_RE = /`[^`\n]+`/g
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g
const HTML_DECLARATION_RE = /<![^>]*>/g
const HTML_TAG_RE = /<\/?[a-zA-Z][\w:-]*(?:\s+(?:[^"'<>]|"[^"]*"|'[^']*')*)?\s*\/?>/g
const KEYCAP_EMOJI_RE = /[0-9#*]\uFE0F?\u20E3/gu
const EMOJI_RE = /\p{Extended_Pictographic}[\uFE0E\uFE0F\u{E0100}-\u{E01EF}]?(?:\u200D\p{Extended_Pictographic}[\uFE0E\uFE0F\u{E0100}-\u{E01EF}]?)*/gu
const SYMBOL_RE = /[\p{So}\p{Sk}\uFE0E\uFE0F\u{E0100}-\u{E01EF}\u200D\u20E3\u2190-\u21FF\u2300-\u23FF\u2460-\u24FF\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2600-\u27BF]/gu
const CONTROL_RE = /[\p{Cc}\p{Cf}]/gu

export function cleanTtsText(content: string): string {
  if (!content) return ''
  return content
    .replace(HIDDEN_REASONING_BLOCK_RE, ' ')
    .replace(UNCLOSED_HIDDEN_REASONING_BLOCK_RE, ' ')
    .replace(FENCED_CODE_BLOCK_RE, ' ')
    .replace(UNCLOSED_FENCED_CODE_BLOCK_RE, ' ')
    .replace(INLINE_CODE_RE, ' ')
    .replace(HTML_COMMENT_RE, ' ')
    .replace(HTML_DECLARATION_RE, ' ')
    .replace(HTML_TAG_RE, ' ')
    .replace(KEYCAP_EMOJI_RE, ' ')
    .replace(EMOJI_RE, ' ')
    .replace(SYMBOL_RE, ' ')
    .replace(CONTROL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function clampTtsText(text: string, maxChars = DEFAULT_MAX_TTS_CHARS): string {
  if (text.length <= maxChars) return text
  if (maxChars <= 3) return '.'.repeat(Math.max(0, maxChars))
  return `${text.slice(0, maxChars - 3)}...`
}
