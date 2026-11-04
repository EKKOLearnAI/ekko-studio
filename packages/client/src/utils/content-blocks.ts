import type { ContentBlock } from '@/api/studio/chat'

export type ParsedContentBlock = ContentBlock | Record<string, unknown>

export interface ParsedMessageReference {
  content: string
  reply: string
}

/**
 * Split a `<quoted_message>`-wrapped content string into the quoted content
 * and the reply that follows it. Returns null when the content carries no
 * quote wrapper.
 */
export function parseMessageReference(content: string): ParsedMessageReference | null {
  if (!content.startsWith('<quoted_message')) return null
  const openEnd = content.indexOf('>\n')
  if (openEnd === -1) return null
  const closeMarker = '\n</quoted_message>'
  const closeStart = content.indexOf(closeMarker, openEnd + 2)
  if (closeStart === -1) return null

  return {
    content: content.slice(openEnd + 2, closeStart).trim(),
    reply: content.slice(closeStart + closeMarker.length).trim(),
  }
}

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
 * contribute their text (a `<quoted_message>` wrapper collapses to its reply,
 * or to the quoted content when no reply exists), attachments append their
 * file name in brackets, and text-less attachment messages fall back to the
 * marker list so the preview is never blank. Browser-selection context text
 * stays hidden, and internal video representative frames are skipped.
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
    if (block?.type === 'image') {
      // Internal video representative frames are not user attachments.
      if ((block as { video_frame?: unknown }).video_frame === true) continue
      const name = (block as { name?: unknown }).name
      attachmentParts.push(`[${typeof name === 'string' && name.trim() ? name.trim() : 'image'}]`)
    } else if (block?.type === 'file') {
      const name = (block as { name?: unknown }).name
      attachmentParts.push(`[${typeof name === 'string' && name.trim() ? name.trim() : 'file'}]`)
    }
  }
  if (textParts.length === 0) return attachmentParts.join(' ') || '[…]'
  let text = textParts.join(' ').trim()
  // Parse the quote wrapper before collapsing whitespace: the wrapper's
  // newline markers are the anchors parseMessageReference matches against.
  const reference = parseMessageReference(text)
  if (reference) text = reference.reply || reference.content
  text = text.replace(/\s+/g, ' ').trim()
  if (text.length > maxTextLength) text = `${text.slice(0, maxTextLength)}...`
  return attachmentParts.length > 0 ? `${text} ${attachmentParts.join(' ')}` : text
}
