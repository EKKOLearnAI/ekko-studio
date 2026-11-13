/** Convert multimodal payloads between the supported provider wire formats. */
export function anthropicImageSourceToUrl(source: any): string | null {
  if (source?.type === 'base64') {
    const mediaType = String(source.media_type || '').trim()
    const data = String(source.data || '').trim()
    if (mediaType && data) return `data:${mediaType};base64,${data}`
  }
  if (source?.type === 'url') {
    const url = String(source.url || '').trim()
    if (url) return url
  }
  return null
}

export function openAiImageUrl(part: any): string | null {
  const value = typeof part?.image_url === 'string'
    ? part.image_url
    : part?.image_url?.url
  const url = String(value || '').trim()
  return url || null
}

export function imageUrlToAnthropicSource(url: string): any | null {
  const value = String(url || '').trim()
  const dataUri = value.match(/^data:([^;,]+);base64,(.+)$/s)
  if (dataUri) {
    return {
      type: 'base64',
      media_type: dataUri[1],
      data: dataUri[2],
    }
  }
  if (/^https?:\/\//i.test(value)) {
    return { type: 'url', url: value }
  }
  return null
}
