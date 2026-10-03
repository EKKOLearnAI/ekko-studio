/** Display-only extraction. Never interprets text as a tool call or mutates history. */
export function sessionDisplayText(value: unknown): string {
  let content = value
  if (typeof content === 'string') {
    const trimmed = content.trim()
    if (!trimmed.startsWith('[')) return content
    try { content = JSON.parse(trimmed) } catch { return typeof value === 'string' ? value : '' }
  }
  if (!Array.isArray(content) || !content.length || !content.every(part => part && typeof part === 'object' && typeof part.type === 'string')) {
    return typeof value === 'string' ? value : ''
  }
  const supported = new Set(['text', 'image', 'image_url', 'file', 'input_text', 'input_image'])
  if (!content.every(part => supported.has(part.type))) return typeof value === 'string' ? value : ''
  const text = content.filter(part => part.type === 'text' || part.type === 'input_text')
    .map(part => typeof part.text === 'string' ? part.text : '').filter(Boolean).join('\n')
  if (text.trim()) return text
  return content.map(part => typeof part.name === 'string' ? part.name : '').filter(Boolean).join(', ')
}
export function sessionDisplayPreview(value: unknown, limit = 63): string {
  return sessionDisplayText(value).replace(/[\r\n]+/g, ' ').slice(0, limit)
}
