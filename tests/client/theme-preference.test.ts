// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import indexHtml from '../../packages/client/index.html?raw'

const bootScript = indexHtml.match(/<script>([\s\S]*?)<\/script>/)![1]

describe.each(['light', 'dark'])('theme style startup in %s mode', (brightness) => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    localStorage.setItem('hermes_brightness', brightness)
    document.documentElement.className = ''
    document.documentElement.removeAttribute('style')
  })

  it.each([
    { saved: null, expected: 'ink' },
    { saved: 'ink', expected: 'ink' },
    { saved: 'comic', expected: 'comic' },
    { saved: 'invalid', expected: 'ink' },
  ])('restores $saved as $expected before and after Vue theme initialization', async ({ saved, expected }) => {
    if (saved !== null) localStorage.setItem('hermes_style', saved)

    new Function('window', 'document', 'localStorage', bootScript)(window, document, localStorage)
    expect(document.documentElement.classList.contains('comic')).toBe(expected === 'comic')
    expect(document.documentElement.classList.contains('dark')).toBe(brightness === 'dark')

    const { useTheme } = await import('@/composables/useTheme')
    const theme = useTheme()
    expect(theme.style.value).toBe(expected)
    expect(theme.isComic.value).toBe(expected === 'comic')
    expect(theme.isDark.value).toBe(brightness === 'dark')
    expect(document.documentElement.classList.contains('comic')).toBe(expected === 'comic')
    expect(document.documentElement.classList.contains('dark')).toBe(brightness === 'dark')
  })
})
