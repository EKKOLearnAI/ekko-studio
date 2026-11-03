import type { ContentBlock } from '@/api/studio/chat'

export type ParsedContentBlock = ContentBlock | Record<string, unknown>

/**
 * Parse a ContentBlock[] message content string. Returns null when the content
 * is plain text rather than a serialized block array.
 *
 * Hermes Agent stored some multimodal user messages via Python str(list),
 * e.g. [{'type': 'text'}, {'type': 'image_url', ...}]. Convert that legacy
 * repr into JSON for display only.
 */
export function parseContentBlocks(content: string): ParsedContentBlock[] | null {
  const trimmed = content.trim()
  if (!trimmed) return null

  const parse = (value: string): ParsedContentBlock[] | null => {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) && parsed.length > 0 && 'type' in parsed[0]
      ? parsed as ParsedContentBlock[]
      : null
  }

  try {
    return parse(trimmed)
  } catch {
    if (!trimmed.startsWith("[{'") && !trimmed.startsWith('[{"')) return null
    try {
      return parse(
        trimmed
          .replace(/\bNone\b/g, 'null')
          .replace(/\bTrue\b/g, 'true')
          .replace(/\bFalse\b/g, 'false')
          .replace(/'/g, '"'),
      )
    } catch {
      return null
    }
  }
}

/**
 * Build the queue-panel preview text for parsed content blocks: text blocks
 * contribute their text (truncated), attachments append their file name in
 * brackets, and text-less attachment messages fall back to the marker list so
 * the preview is never blank. Browser-selection context text stays hidden.
 */
export function blocksQueuePreview(blocks: ParsedContentBlock[], maxTextLength = 48): string {
  const textParts: string[] = []
  for (const block of blocks) {
    if (block?.type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
      const text = (block as { text: string }).text.trim()
      if (text && !text.startsWith('<browser_selection_context')) textParts.push(text)
    }
  }
  const attachmentParts: string[] = []
  for (const block of blocks) {
    if (block?.type === 'image' || block?.type === 'file') {
      const name = (block as { name?: unknown }).name
      const label = typeof name === 'string' && name.trim() ? name.trim() : String(block.type)
      attachmentParts.push(`[${label}]`)
    }
  }
  if (textParts.length === 0) return attachmentParts.join(' ') || '[…]'
  let text = textParts.join(' ').replace(/\s+/g, ' ').trim()
  if (text.length > maxTextLength) text = `${text.slice(0, maxTextLength)}...`
  return attachmentParts.length > 0 ? `${text} ${attachmentParts.join(' ')}` : text
}
