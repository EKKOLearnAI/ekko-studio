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

describe('three-state brightness shortcut', () => {
  beforeEach(() => { vi.resetModules(); localStorage.clear(); document.documentElement.className = '' })
  it('cycles system, light, dark, system and persists a restorable system preference', async () => {
    const { useTheme } = await import('@/composables/useTheme')
    const theme = useTheme()
    expect(theme.brightness.value).toBe('system')
    for (const expected of ['light', 'dark', 'system']) {
      await theme.toggleBrightness()
      expect(theme.brightness.value).toBe(expected)
      expect(localStorage.getItem('hermes_brightness')).toBe(expected)
    }
    vi.resetModules()
    expect((await import('@/composables/useTheme')).useTheme().brightness.value).toBe('system')
  })
  it('responds to live device changes only in system mode', async () => {
    let dark = false
    const listeners: Array<() => void> = []
    const spy = vi.spyOn(window, 'matchMedia').mockImplementation(query => ({
      get matches() { return dark }, media: query,
      addEventListener: (_name: string, callback: () => void) => listeners.push(callback), removeEventListener: vi.fn(),
    } as unknown as MediaQueryList))
    try {
      const theme = (await import('@/composables/useTheme')).useTheme()
      expect(theme.isDark.value).toBe(false)
      dark = true; listeners.forEach(fn => fn())
      expect(theme.isDark.value).toBe(true)
      await theme.setBrightness('light')
      dark = false; listeners.forEach(fn => fn())
      dark = true; listeners.forEach(fn => fn())
      expect(theme.isDark.value).toBe(false)
      await theme.setBrightness('system')
      expect(theme.isDark.value).toBe(true)
    } finally { spy.mockRestore() }
  })
})
