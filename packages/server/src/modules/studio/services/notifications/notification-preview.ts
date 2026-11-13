/** Explicit display fields only. Never use prompt, raw error, tool or history fallback. */
export function notificationPreview(value: unknown, completion: boolean) {
  const display = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const visibleText = (input: unknown): string => {
    if (typeof input !== 'string') return ''
    const trimmed = input.trim()
    if (!trimmed || (!trimmed.startsWith('[') && !trimmed.startsWith('{'))) return input
    try {
      const parsed = JSON.parse(trimmed) as unknown
      const parts = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).content)
        ? (parsed as Record<string, unknown>).content as unknown[] : []
      const text = parts.flatMap(part => part && typeof part === 'object' && (part as Record<string, unknown>).type === 'text'
        && typeof (part as Record<string, unknown>).text === 'string' ? [(part as Record<string, unknown>).text as string] : []).join('\n')
      return text || ''
    } catch { return input }
  }
  const plain = (input: unknown, limit: number): string => {
    const visible = visibleText(input)
    if (!visible) return ''
    const text = visible.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}[#>]+\s*/gm, '').replace(/[*_`~]/g, '')
      .replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim()
    const chars = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), part => part.segment)
    return chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : text
  }
  return { title: plain(display.title, 40), body: completion ? plain(display.content || display.preview, 160) : '' }
}
