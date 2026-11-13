const IMAGE_PART_TYPES = new Set(['image', 'image_url', 'input_image'])
const DATA_IMAGE_RE = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+/g

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isContentPart(value: unknown): value is Record<string, unknown> {
  return isPlainRecord(value) && typeof value.type === 'string'
}

function summarizeContentParts(parts: unknown[]): string | null {
  let sawContentPart = false
  const text: string[] = []

  for (const part of parts) {
    if (!isContentPart(part)) continue
    const type = String(part.type)
    if (type === 'text') {
      sawContentPart = true
      const value = part.text
      if (value != null) text.push(String(value))
    } else if (IMAGE_PART_TYPES.has(type)) {
      sawContentPart = true
      text.push('[screenshot]')
    }
  }

  return sawContentPart ? text.filter(Boolean).join('\n') : null
}

function summarizeMultimodalEnvelope(value: Record<string, unknown>): string | null {
  if (value._multimodal !== true && !Array.isArray(value.content)) return null
  const parts = Array.isArray(value.content) ? value.content : []
  if (!parts.length) return null
  return summarizeContentParts(parts)
}

function isPathAttachmentContent(parts: unknown[]): boolean {
  let sawAttachment = false
  if (!parts.length) return false
  for (const part of parts) {
    if (!isContentPart(part)) return false
    if (part.type === 'text') {
      if (typeof part.text !== 'string') return false
      continue
    }
    if (part.type !== 'image' && part.type !== 'file') return false
    if (typeof part.path !== 'string' || !part.path.trim()) return false
    sawAttachment = true
  }
  return sawAttachment
}

function redactDataImages(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(DATA_IMAGE_RE, '[screenshot]')
  if (Array.isArray(value)) return value.map(redactDataImages)
  if (!isPlainRecord(value)) return value

  const cleaned: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    cleaned[key] = redactDataImages(child)
  }
  return cleaned
}

function summarizeKnownMultimodalContent(value: unknown): string | null {
  if (Array.isArray(value)) {
    return summarizeContentParts(value)
  }

  if (isPlainRecord(value)) {
    return summarizeMultimodalEnvelope(value)
  }

  return null
}

function serializeStructuredMessageContent(value: unknown): string | null {
  if (Array.isArray(value) && isPathAttachmentContent(value)) {
    return JSON.stringify(redactDataImages(value))
  }
  const summary = summarizeKnownMultimodalContent(value)
  if (summary != null) return summary
  if (Array.isArray(value) || isPlainRecord(value)) return JSON.stringify(redactDataImages(value))
  return null
}

function shouldTryParseStructuredString(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return false
  if (trimmed.includes('_multimodal') || trimmed.includes('data:image/')) return true
  return (
    trimmed.includes('"image_url"') ||
    trimmed.includes('"input_image"') ||
    trimmed.includes('"type":"image"') ||
    trimmed.includes('"type": "image"')
  )
}

export function normalizeMessageContentForStorage(content: unknown): string {
  if (typeof content === 'string') {
    if (shouldTryParseStructuredString(content)) {
      try {
        const parsed = JSON.parse(content.trim())
        const normalized = serializeStructuredMessageContent(parsed)
        if (normalized != null) return normalized
      } catch {
        // Fall back to direct redaction below.
      }
    }
    return content.replace(DATA_IMAGE_RE, '[screenshot]')
  }

  const normalized = serializeStructuredMessageContent(content)
  if (normalized != null) return normalized
  return String(content ?? '')
}

export function normalizeMessageContentForStorageRole(role: string | undefined | null, content: string): string {
  return role === 'user' ? content : normalizeMessageContentForStorage(content)
}
