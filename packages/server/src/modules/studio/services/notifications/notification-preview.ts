/** Explicit display fields only. Never use prompt, raw error, tool or history fallback. */
export function notificationPreview(value: unknown, completion: boolean) {
  const display = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const plain = (input: unknown, limit: number): string => {
    if (typeof input !== 'string') return ''
    const text = input.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}[#>]+\s*/gm, '').replace(/[*_`~]/g, '')
      .replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim()
    const chars = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), part => part.segment)
    return chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : text
  }
  return { title: plain(display.title, 40), body: completion ? plain(display.content || display.preview, 160) : '' }
}
