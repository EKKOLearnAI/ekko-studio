// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config, mount } from '@vue/test-utils'
import { nextTick } from 'vue'

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async (id: string, source: string) => ({
    svg: `<svg id="${id}" data-testid="mermaid-svg"><text>${source}</text></svg>`,
  })),
}))

const downloadApiMock = vi.hoisted(() => ({
  downloadFile: vi.fn(() => Promise.resolve()),
  fetchFileText: vi.fn(() => Promise.resolve('preview content')),
  getDownloadUrl: vi.fn((path: string) => `http://test.local/api/studio/files/download?path=${encodeURIComponent(path)}`),
}))

const desktopBrowserMock = vi.hoisted(() => ({
  openUrlInDesktopBrowser: vi.fn((_url: string) => Promise.resolve(false)),
}))

function trustedDesktopBrowserBridge() {
  const createTab = vi.fn().mockResolvedValue({ id: 'web-tab' })
  const methods = [
    'getState', 'setViewport', 'closeTab', 'activateTab', 'navigate',
    'navigationAction', 'createProfile', 'chooseProfileRootDirectory', 'renameProfile', 'profileSwitchImpact',
    'switchProfile', 'updateProfile', 'deleteProfile', 'clearProfileData', 'cancelDownload',
    'takeOver', 'annotate', 'cancelAnnotation', 'updateAnnotationNote',
    'captureAnnotations', 'clearAnnotations', 'onAnnotationRequest', 'onStateChange',
  ]
  return {
    ...Object.fromEntries(methods.map(method => [method, vi.fn()])),
    createTab,
  }
}

vi.mock('mermaid', () => ({
  default: mermaidMock,
}))

vi.mock('@/utils/desktop-browser', () => ({
  openUrlInDesktopBrowser: desktopBrowserMock.openUrlInDesktopBrowser,
}))

async function flushMermaidRender(): Promise<void> {
  for (let i = 0; i < 16; i += 1) {
    await nextTick()
    await Promise.resolve()
  }
}

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', () => ({
  NDrawer: {
    props: ['show', 'width'],
    template: '<div v-if="show" class="n-drawer-stub" :data-width="width"><slot /></div>',
  },
  NDrawerContent: {
    props: {
      title: { type: String, default: '' },
      closable: { type: Boolean, default: false },
      bodyContentStyle: { type: [Object, String], default: undefined },
    },
    template: '<section class="n-drawer-content-stub" :data-body-padding="bodyContentStyle && bodyContentStyle.padding"><header class="n-drawer-header-stub">{{ title }}<button v-if="closable" class="n-drawer-close-stub" @click="$emit(\'close\')">x</button></header><slot /></section>',
  },
  NSpin: {
    props: ['show'],
    template: '<div class="n-spin-stub"><slot /></div>',
  },
  useMessage: () => ({
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
}))

vi.mock('@/api/studio/download', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/studio/download')>()
  return {
    ...actual,
    downloadFile: downloadApiMock.downloadFile,
    fetchFileText: downloadApiMock.fetchFileText,
    getDownloadUrl: downloadApiMock.getDownloadUrl,
  }
})

import MarkdownRenderer from '@/components/hermes/chat/MarkdownRenderer.vue'

config.global.provide.hermesWorkspaceFilePreview = true

describe('MarkdownRenderer', () => {
  it('waits for the final group message before requesting its published image', async () => {
    const resolver = vi.fn(() => '/api/studio/group-chat/invites/ROOM1/attachments/answer.png')
    const wrapper = mount(MarkdownRenderer, { props: {
      content: '![answer](/workspace/answer.png)', deferImages: true, resolveImageUrl: resolver,
    } })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(resolver).not.toHaveBeenCalled()
    await wrapper.setProps({ deferImages: false })
    expect(wrapper.get('img').attributes('src')).toBe('/api/studio/group-chat/invites/ROOM1/attachments/answer.png')
    wrapper.unmount()
  })
  it('uses the group image resolver for local images while leaving public images alone', () => {
    const resolveImageUrl = vi.fn(path => `/api/studio/group-chat/invites/ROOM1/attachments/${encodeURIComponent(path.split('/').pop())}`)
    const wrapper = mount(MarkdownRenderer, { props: {
      content: '![图片](</workspace/马年 image.png>)\n\n![public](https://example.com/photo.png)', resolveImageUrl,
    } })
    const images = wrapper.findAll('img')
    expect(images[0].attributes('src')).toBe('/api/studio/group-chat/invites/ROOM1/attachments/%E9%A9%AC%E5%B9%B4%20image.png')
    expect(images[1].attributes('src')).toBe('https://example.com/photo.png')
    expect(resolveImageUrl).toHaveBeenCalledWith('/workspace/马年 image.png')
    expect(downloadApiMock.getDownloadUrl).not.toHaveBeenCalled()
    wrapper.unmount()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  beforeEach(() => {
    window.localStorage.clear()
    delete (window as typeof window & { hermesDesktop?: unknown }).hermesDesktop
    mermaidMock.initialize.mockClear()
    mermaidMock.render.mockClear()
    downloadApiMock.downloadFile.mockClear()
    downloadApiMock.fetchFileText.mockClear()
    downloadApiMock.getDownloadUrl.mockClear()
    desktopBrowserMock.openUrlInDesktopBrowser.mockReset()
    desktopBrowserMock.openUrlInDesktopBrowser.mockResolvedValue(false)
    mermaidMock.render.mockImplementation(async (id: string, source: string) => ({
      svg: `<svg id="${id}" data-testid="mermaid-svg"><text>${source}</text></svg>`,
    }))
    downloadApiMock.downloadFile.mockResolvedValue(undefined)
    downloadApiMock.fetchFileText.mockResolvedValue('preview content')
    downloadApiMock.getDownloadUrl.mockImplementation((path: string) => `http://test.local/api/studio/files/download?path=${encodeURIComponent(path)}`)

    Object.defineProperty(window, 'isSecureContext', {
      configurable: true,
      value: true,
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    })
  })

  it('preserves ASCII quotes in prose without disabling other typographic replacements', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: `Men's "quoted" -- ... (c)`,
      },
    })

    expect(wrapper.get('.markdown-body').text()).toBe(`Men's "quoted" – … ©`)
  })

  it('cancels native message-link navigation before desktop routing begins', () => {
    desktopBrowserMock.openUrlInDesktopBrowser.mockResolvedValue(true)
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '[Hermes](https://example.com/docs)',
      },
    })
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })

    wrapper.get('a').element.dispatchEvent(click)

    expect(click.defaultPrevented).toBe(true)
  })

  it('does not reinterpret external path query parameters as local files', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '[External source](https://example.com/view?path=/tmp/secret.ts)',
      },
    })

    const link = wrapper.get('a')
    expect(link.attributes('href')).toBe('https://example.com/view?path=/tmp/secret.ts')
    expect(link.classes()).not.toContain('markdown-file-link')
    expect(wrapper.find('.markdown-file-card').exists()).toBe(false)
  })

  it('does not unwrap a Studio-shaped download URL from a foreign origin', () => {
    const href = `https://attacker.example/api/studio/files/download?path=${encodeURIComponent('/Users/alice/project/.env')}`
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: `[External download](${href})`,
      },
    })

    const link = wrapper.get('a')
    expect(link.attributes('href')).toBe(href)
    expect(link.classes()).not.toContain('markdown-file-link')
    expect(wrapper.find('.markdown-file-card').exists()).toBe(false)
  })

  it('applies desktop routing to case-insensitive HTTP schemes', async () => {
    desktopBrowserMock.openUrlInDesktopBrowser.mockResolvedValue(true)
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '[Hermes](HTTPS://example.com/docs)',
      },
    })

    await wrapper.get('a').trigger('click')

    expect(desktopBrowserMock.openUrlInDesktopBrowser).toHaveBeenCalledWith('HTTPS://example.com/docs')
  })

  it('routes scheme-relative web links instead of treating them as local files', async () => {
    desktopBrowserMock.openUrlInDesktopBrowser.mockResolvedValue(true)
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '[Hermes](//example.com/docs)',
      },
    })

    await wrapper.get('a').trigger('click')

    expect(desktopBrowserMock.openUrlInDesktopBrowser).toHaveBeenCalledWith(`${window.location.protocol}//example.com/docs`)
  })

  it('opens message links in the embedded browser when the desktop bridge is available', async () => {
    desktopBrowserMock.openUrlInDesktopBrowser.mockResolvedValue(true)
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '[Hermes](https://example.com/docs)',
      },
    })

    await wrapper.get('a').trigger('click')

    expect(desktopBrowserMock.openUrlInDesktopBrowser).toHaveBeenCalledWith('https://example.com/docs')
    expect(open).not.toHaveBeenCalled()
    open.mockRestore()
  })

  it('keeps opening message links in a new tab in the Web UI', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '[Hermes](https://example.com/docs)',
      },
    })

    await wrapper.get('a').trigger('click')

    expect(desktopBrowserMock.openUrlInDesktopBrowser).toHaveBeenCalledWith('https://example.com/docs')
    expect(open).toHaveBeenCalledWith('https://example.com/docs', '_blank', 'noopener,noreferrer')
    open.mockRestore()
  })

  it('uses the stored default-browser preference for a rendered message link', async () => {
    window.localStorage.setItem('hermes_link_open_target', 'default-browser')
    const browser = trustedDesktopBrowserBridge()
    ;(window as typeof window & { hermesDesktop?: unknown }).hermesDesktop = { isDesktop: true, browser }
    desktopBrowserMock.openUrlInDesktopBrowser.mockImplementation(async (url: string) => {
      const actual = await vi.importActual<{
        openUrlInDesktopBrowser: (targetUrl: string) => Promise<boolean>
      }>('@/utils/desktop-browser')
      return actual.openUrlInDesktopBrowser(url)
    })
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '[Hermes](https://example.com/docs)',
      },
    })

    try {
      await wrapper.get('a').trigger('click')

      expect(desktopBrowserMock.openUrlInDesktopBrowser).toHaveBeenCalledWith('https://example.com/docs')
      expect(browser.createTab).not.toHaveBeenCalled()
      await vi.waitFor(() => {
        expect(open).toHaveBeenCalledWith('https://example.com/docs', '_blank', 'noopener,noreferrer')
      })
    } finally {
      open.mockRestore()
    }
  })

  it('uses desktop external-url IPC for same-origin links with the default-browser target', async () => {
    window.localStorage.setItem('hermes_link_open_target', 'default-browser')
    const browser = trustedDesktopBrowserBridge()
    const openExternalUrl = vi.fn().mockResolvedValue(true)
    ;(window as typeof window & { hermesDesktop?: unknown }).hermesDesktop = {
      isDesktop: true,
      browser,
      openExternalUrl,
    }
    desktopBrowserMock.openUrlInDesktopBrowser.mockImplementation(async (url: string) => {
      const actual = await vi.importActual<{
        openUrlInDesktopBrowser: (targetUrl: string) => Promise<boolean>
      }>('@/utils/desktop-browser')
      return actual.openUrlInDesktopBrowser(url)
    })
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const sameOriginUrl = `${window.location.origin}/docs`
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: `[Docs](${sameOriginUrl})`,
      },
    })

    try {
      await wrapper.get('a').trigger('click')

      await vi.waitFor(() => {
        expect(openExternalUrl).toHaveBeenCalledWith(sameOriginUrl)
      })
      expect(open).not.toHaveBeenCalled()
    } finally {
      open.mockRestore()
    }
  })

  it('does not fall back to window.open when desktop default-browser IPC fails', async () => {
    window.localStorage.setItem('hermes_link_open_target', 'default-browser')
    const browser = trustedDesktopBrowserBridge()
    const openExternalUrl = vi.fn().mockResolvedValue(false)
    ;(window as typeof window & { hermesDesktop?: unknown }).hermesDesktop = {
      isDesktop: true,
      browser,
      openExternalUrl,
    }
    desktopBrowserMock.openUrlInDesktopBrowser.mockImplementation(async (url: string) => {
      const actual = await vi.importActual<{
        openUrlInDesktopBrowser: (targetUrl: string) => Promise<boolean>
      }>('@/utils/desktop-browser')
      return actual.openUrlInDesktopBrowser(url)
    })
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const sameOriginUrl = `${window.location.origin}/docs`
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: `[Docs](${sameOriginUrl})`,
      },
    })

    try {
      await wrapper.get('a').trigger('click')

      await vi.waitFor(() => {
        expect(openExternalUrl).toHaveBeenCalledWith(sameOriginUrl)
      })
      expect(open).not.toHaveBeenCalled()
    } finally {
      open.mockRestore()
    }
  })

  it('highlights vue fenced blocks instead of rendering them as plain text', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '```vue\n<template><div>Hello</div></template>\n```',
      },
    })

    expect(wrapper.find('.code-lang').text()).toBe('vue')
    expect(wrapper.find('code.hljs').html()).toContain('hljs-tag')
  })

  it('keeps shell-session fences on the shell grammar', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '```shell\n$ ls\nfoo.txt\n```',
      },
    })

    expect(wrapper.find('.code-lang').text()).toBe('shell')
    expect(wrapper.find('code.hljs').html()).toContain('hljs-meta')
  })

  it('still highlights long supported code fences', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: `\`\`\`json\n${JSON.stringify({ content: 'x'.repeat(2500), ok: true })}\n\`\`\``,
      },
    })

    expect(wrapper.find('.code-lang').text()).toBe('json')
    expect(wrapper.find('code.hljs').html()).toMatch(/hljs-(attr|string|punctuation)/)
  })

  it('falls back to plain escaped text when a fence language is unsupported', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '```foobar\n{"answer":42,"ok":true}\n```',
      },
    })

    expect(wrapper.find('.code-lang').text()).toBe('foobar')
    expect(wrapper.find('code.hljs').findAll('span')).toHaveLength(0)
    expect(wrapper.find('code.hljs').text()).toContain('{"answer":42,"ok":true}')
  })

  it('keeps unlabeled code fences as plain text instead of guessing a grammar', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '```\nINFO Starting server\nConnected to 127.0.0.1\nDone\n```',
      },
    })

    expect(wrapper.find('.code-lang').text()).toBe('text')
    expect(wrapper.find('code.hljs').findAll('span')).toHaveLength(0)
    expect(wrapper.find('code.hljs').text()).toContain('INFO Starting server')
  })

  it('renders outer markdown draft fences as markdown while preserving nested fenced examples', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: [
          '下面是可直接手动编辑的 PR draft。',
          '',
          '```md',
          '标题: fix(chat): 保留附件在同一聊天后续轮次的上下文',
          '',
          '## Summary',
          '',
          '附件上传后，首轮 `startRun()` 的 `input` 已包含上传文件引用:',
          '',
          '```md',
          '[File: screenshot.png](/uploaded/path)',
          '```',
          '',
          '但本地保存的用户消息只保留 UI 可见文本。',
          '',
          '## Fix',
          '- Preserve context.',
          '```',
        ].join('\n'),
      },
    })

    expect(wrapper.findAll('.hljs-code-block')).toHaveLength(1)
    expect(wrapper.find('.code-lang').text()).toBe('md')
    expect(wrapper.find('code.hljs').text()).toContain('[File: screenshot.png](/uploaded/path)')
    expect(wrapper.find('.markdown-body').findAll('h2')).toHaveLength(2)
    expect(wrapper.find('.markdown-body').find('h2').text()).toBe('Summary')
    expect(wrapper.find('.markdown-body').text()).toContain('但本地保存的用户消息只保留 UI 可见文本。')
    expect(wrapper.find('.markdown-body').text()).toContain('Preserve context.')
  })

  it('keeps markdown examples with their own nested fences intact after unwrapping a draft fence', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: [
          '```md',
          '## Regression Coverage',
          '',
          '```md',
          '下面是一个 PR draft。',
          '',
          '```md',
          '[File: Screenshot.png](/tmp/example.png)',
          '```',
          '',
          '## Fix',
          '',
          '- 后续 heading 不应被截断。',
          '```',
          '',
          '## Local Verification',
          '',
          '- localhost renders after the example.',
          '```',
        ].join('\n'),
      },
    })

    const headings = wrapper.find('.markdown-body').findAll('h2').map(heading => heading.text())
    expect(headings).toEqual(['Regression Coverage', 'Local Verification'])
    expect(wrapper.findAll('.hljs-code-block')).toHaveLength(1)

    const codeText = wrapper.find('code.hljs').text()
    expect(codeText).toContain('下面是一个 PR draft。')
    expect(codeText).toContain('```md\n[File: Screenshot.png](/tmp/example.png)\n```')
    expect(codeText).toContain('## Fix')
    expect(codeText).toContain('- 后续 heading 不应被截断。')
    expect(wrapper.find('.markdown-body').text()).toContain('localhost renders after the example.')
  })

  it('keeps markdown examples with unlabeled nested fences intact', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: [
          '```md',
          '## Unlabeled Fence Example',
          '',
          '```md',
          '```',
          'plain nested block',
          '```',
          '```',
          '',
          'Done outside.',
          '```',
        ].join('\n'),
      },
    })

    expect(wrapper.find('.markdown-body').find('h2').text()).toBe('Unlabeled Fence Example')
    expect(wrapper.findAll('.hljs-code-block')).toHaveLength(1)
    expect(wrapper.find('code.hljs').text()).toContain('```\nplain nested block\n```')
    expect(wrapper.find('.markdown-body').text()).toContain('Done outside.')
  })

  it('renders local mov links as inline video players', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '[录屏2026-05-08 15.19.46.mov](/Users/ekko/Desktop/录屏2026-05-08%2015.19.46.mov)',
      },
    })

    const video = wrapper.find('video.markdown-video')
    expect(video.exists()).toBe(true)
    expect(video.attributes('src')).toContain('/api/studio/files/download?path=')
    const src = new URL(video.attributes('src'))
    expect(decodeURIComponent(src.searchParams.get('path') || '')).toBe('/Users/ekko/Desktop/录屏2026-05-08 15.19.46.mov')
    expect(wrapper.find('.markdown-video-footer .att-name').text()).toBe('录屏2026-05-08 15.19.46.mov')
  })

  it('renders local mp3 links as inline audio players', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '[song.mp3](/tmp/song.mp3)',
      },
    })

    const audio = wrapper.find('audio.markdown-audio')
    expect(audio.exists()).toBe(true)
    expect(audio.attributes('controls')).toBeDefined()
    expect(audio.attributes('preload')).toBe('metadata')
    expect(audio.attributes('src')).toContain('/api/studio/files/download?path=')
    const src = new URL(audio.attributes('src'))
    expect(decodeURIComponent(src.searchParams.get('path') || '')).toBe('/tmp/song.mp3')
    expect(wrapper.find('.markdown-audio-footer .att-name').text()).toBe('song.mp3')
    expect(wrapper.find('.markdown-file-card').exists()).toBe(false)
  })

  it('renders MSYS-style Windows image paths through the download endpoint', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '![桌面截图](/c/Users/Administrator/Desktop/screenshot.png)',
      },
    })

    const img = wrapper.find('img')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toContain('/api/studio/files/download?path=')
    const src = new URL(img.attributes('src'))
    expect(decodeURIComponent(src.searchParams.get('path') || '')).toBe('/c/Users/Administrator/Desktop/screenshot.png')
    expect(img.attributes('alt')).toBe('桌面截图')
  })

  it('keeps inline image clicks in the image overlay instead of the file drawer', async () => {
    const previewRequests: unknown[] = []
    const handlePreview = (event: Event) => previewRequests.push((event as CustomEvent).detail)
    window.addEventListener('hermes:preview-workspace-file', handlePreview)
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '![preview](/tmp/preview.png)',
      },
    })

    try {
      await wrapper.find('img').trigger('click')
      await nextTick()
      expect(previewRequests).toEqual([])
      expect(document.body.querySelector('.image-preview-overlay')).not.toBeNull()
      expect(document.body.querySelector('.image-preview-img')?.getAttribute('src')).toContain('/api/studio/files/download?path=')
    } finally {
      wrapper.unmount()
      window.removeEventListener('hermes:preview-workspace-file', handlePreview)
    }
  })

  it('keeps a working download card when the rendering context has no workspace preview host', async () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '[notes.txt](/tmp/notes.txt)',
      },
      global: {
        provide: {
          hermesWorkspaceFilePreview: false,
        },
      },
    })

    expect(wrapper.find('.markdown-file-link').exists()).toBe(false)
    const downloadCard = wrapper.get('.markdown-file-card')
    expect(downloadCard.element.tagName).toBe('BUTTON')
    expect(downloadCard.attributes('aria-label')).toBe('download.downloadFile: notes.txt')
    expect(wrapper.find('.att-download-btn').exists()).toBe(false)
    await downloadCard.trigger('click')
    await Promise.resolve()
    expect(downloadApiMock.downloadFile).toHaveBeenCalledWith('/tmp/notes.txt', 'notes.txt')
  })

  it('renders previewable local files as lightweight inline links without a download affordance', async () => {
    const previewRequests: Array<{ path: string; fileName: string; previewOnly?: boolean }> = []
    const handlePreview = (event: Event) => {
      const customEvent = event as CustomEvent<(typeof previewRequests)[number]>
      previewRequests.push(customEvent.detail)
      customEvent.preventDefault()
    }
    window.addEventListener('hermes:preview-workspace-file', handlePreview)
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '[notes.txt](/tmp/notes.txt)',
      },
    })

    try {
      expect(wrapper.find('.markdown-file-card').exists()).toBe(false)
      expect(wrapper.find('.att-download-btn').exists()).toBe(false)
      const fileLink = wrapper.get('a.markdown-file-link')
      expect(fileLink.text()).toBe('notes.txt')
      expect(fileLink.attributes('title')).toBe('files.preview')

      await fileLink.trigger('click')
      expect(previewRequests).toEqual([{
        path: '/tmp/notes.txt',
        fileName: 'notes.txt',
        previewOnly: true,
      }])
      expect(downloadApiMock.downloadFile).not.toHaveBeenCalled()
      expect(downloadApiMock.fetchFileText).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
      window.removeEventListener('hermes:preview-workspace-file', handlePreview)
    }
  })

  it('keeps files without an in-app preview as explicit download cards', async () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '[下载压缩包](/tmp/archive.zip)',
      },
    })

    expect(wrapper.find('.markdown-file-card').exists()).toBe(true)
    expect(wrapper.find('.markdown-file-link').exists()).toBe(false)
    await wrapper.find('.markdown-file-card').trigger('click')
    await Promise.resolve()

    expect(downloadApiMock.downloadFile).toHaveBeenCalledTimes(1)
    expect(downloadApiMock.downloadFile).toHaveBeenCalledWith('/tmp/archive.zip', 'archive.zip')
  })

  it('escapes decoded download paths before rendering unsupported file cards', () => {
    const injectedPath = '/tmp/archive.zip" onmouseover="alert(1)'
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: `[archive.zip](/api/studio/files/download?path=${encodeURIComponent(injectedPath)})`,
      },
    })

    const card = wrapper.get('.markdown-file-card')
    expect(card.attributes('data-path')).toBe(injectedPath)
    expect(card.attributes('onmouseover')).toBeUndefined()
    expect(card.element.tagName).toBe('BUTTON')
    expect(card.find('.att-download-icon').exists()).toBe(true)
  })

  it('requests text previews through the shared workspace tool panel', async () => {
    const previewRequests: Array<{ path: string; fileName: string; previewOnly?: boolean }> = []
    const handlePreview = (event: Event) => {
      const customEvent = event as CustomEvent<(typeof previewRequests)[number]>
      previewRequests.push(customEvent.detail)
      customEvent.preventDefault()
    }
    window.addEventListener('hermes:preview-workspace-file', handlePreview)
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '[notes.txt](/tmp/notes.txt)',
      },
    })

    try {
      await wrapper.find('.markdown-file-link').trigger('click')
      expect(previewRequests).toEqual([{
        path: '/tmp/notes.txt',
        fileName: 'notes.txt',
        previewOnly: true,
      }])
      expect(downloadApiMock.fetchFileText).not.toHaveBeenCalled()
      expect(downloadApiMock.downloadFile).not.toHaveBeenCalled()
      expect(wrapper.find('.n-drawer-stub').exists()).toBe(false)
    } finally {
      window.removeEventListener('hermes:preview-workspace-file', handlePreview)
    }
  })

  it('applies the inline preview affordance to rich labels and anchored download URLs', async () => {
    const previewRequests: Array<{
      path: string
      fileName: string
      previewOnly?: boolean
      startLine?: number
      endLine?: number
    }> = []
    const handlePreview = (event: Event) => {
      const customEvent = event as CustomEvent<(typeof previewRequests)[number]>
      previewRequests.push(customEvent.detail)
      customEvent.preventDefault()
    }
    window.addEventListener('hermes:preview-workspace-file', handlePreview)
    const href = `/api/studio/files/download?path=${encodeURIComponent('/tmp/status.ts#L12-L14')}`
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: `[**status.ts:12–14**](<${href}> "source location")`,
      },
    })

    try {
      expect(wrapper.find('.markdown-file-card').exists()).toBe(false)
      const fileLink = wrapper.get('a.markdown-file-link')
      expect(fileLink.get('strong').text()).toBe('status.ts:12–14')
      expect(fileLink.attributes('title')).toBe('files.preview')

      await fileLink.trigger('click')
      expect(previewRequests).toEqual([{
        path: '/tmp/status.ts',
        fileName: 'status.ts',
        previewOnly: true,
        startLine: 12,
        endLine: 14,
      }])
      expect(downloadApiMock.downloadFile).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
      window.removeEventListener('hermes:preview-workspace-file', handlePreview)
    }
  })

  it('keeps code-styled local file links as markdown while previewing them', async () => {
    const previewRequests: Array<{ path: string; fileName: string; previewOnly?: boolean }> = []
    const handlePreview = (event: Event) => {
      const customEvent = event as CustomEvent<{ path: string; fileName: string; previewOnly?: boolean }>
      previewRequests.push(customEvent.detail)
      customEvent.preventDefault()
    }
    window.addEventListener('hermes:preview-workspace-file', handlePreview)
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '[`release-maintainer/SKILL.md`](</Users/zeeland/.hermes/skills/release-maintainer/SKILL.md>)',
      },
    })

    try {
      expect(wrapper.find('.markdown-file-card').exists()).toBe(false)
      const link = wrapper.get('a')
      expect(link.attributes('href')).toBe('/Users/zeeland/.hermes/skills/release-maintainer/SKILL.md')
      expect(link.get('code').text()).toBe('release-maintainer/SKILL.md')
      const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true })
      link.element.dispatchEvent(clickEvent)
      expect(clickEvent.defaultPrevented).toBe(true)
      await vi.waitFor(() => {
        expect(previewRequests).toEqual([{
          path: '/Users/zeeland/.hermes/skills/release-maintainer/SKILL.md',
          fileName: 'release-maintainer/SKILL.md',
          previewOnly: true,
        }])
      })
      expect(downloadApiMock.downloadFile).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
      window.removeEventListener('hermes:preview-workspace-file', handlePreview)
    }
  })

  it('does not download a previewable code-styled link when no preview host accepts it', async () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '[`release-maintainer/SKILL.md`](</tmp/release-maintainer/SKILL.md>)',
      },
    })
    const link = wrapper.get('a')
    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true })

    link.element.dispatchEvent(clickEvent)
    await vi.waitFor(() => expect(clickEvent.defaultPrevented).toBe(true))

    expect(downloadApiMock.downloadFile).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('separates colon-style line and column suffixes from local workspace file paths', async () => {
    const previewRequests: Array<{
      path: string
      fileName: string
      previewOnly?: boolean
      startLine?: number
      endLine?: number
    }> = []
    const handlePreview = (event: Event) => {
      const customEvent = event as CustomEvent<(typeof previewRequests)[number]>
      previewRequests.push(customEvent.detail)
      customEvent.preventDefault()
    }
    window.addEventListener('hermes:preview-workspace-file', handlePreview)
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: [
          '[DesktopBrowserPanel.vue](/Users/ekko/workspace/DesktopBrowserPanel.vue:123)',
          '[browser-manager.ts](C:/Users/Administrator/workspace/browser-manager.ts:950:12)',
          String.raw`[native-windows.ts](<C:\Users\Administrator\workspace\native-windows.ts:951:8>)`,
        ].join('\n'),
      },
    })

    try {
      const references = wrapper.findAll('.markdown-file-link')
      expect(references).toHaveLength(3)
      await references[0].trigger('click')
      await references[1].trigger('click')
      await references[2].trigger('click')
      expect(previewRequests).toEqual([
        {
          path: '/Users/ekko/workspace/DesktopBrowserPanel.vue',
          fileName: 'DesktopBrowserPanel.vue',
          previewOnly: true,
          startLine: 123,
          endLine: 123,
        },
        {
          path: 'C:/Users/Administrator/workspace/browser-manager.ts',
          fileName: 'browser-manager.ts',
          previewOnly: true,
          startLine: 950,
          endLine: 950,
        },
        {
          path: 'C:/Users/Administrator/workspace/native-windows.ts',
          fileName: 'native-windows.ts',
          previewOnly: true,
          startLine: 951,
          endLine: 951,
        },
      ])
    } finally {
      wrapper.unmount()
      window.removeEventListener('hermes:preview-workspace-file', handlePreview)
    }
  })

  it('passes GitHub-style line anchors to workspace previews without treating them as file paths', async () => {
    const previewRequests: Array<{
      path: string
      fileName: string
      previewOnly?: boolean
      startLine?: number
      endLine?: number
    }> = []
    const handlePreview = (event: Event) => {
      const customEvent = event as CustomEvent<(typeof previewRequests)[number]>
      previewRequests.push(customEvent.detail)
      customEvent.preventDefault()
    }
    window.addEventListener('hermes:preview-workspace-file', handlePreview)
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: [
          '[补偿升级入口:550](/Users/zeeland/projects/rudder-oss/heartbeat.release.ts#L550)',
          '[状态限制:354–381](/Users/zeeland/projects/rudder-oss/issues.ts#L354-L381)',
        ].join('\n'),
      },
    })

    try {
      const references = wrapper.findAll('.markdown-file-link')
      expect(references).toHaveLength(2)
      await references[0].trigger('click')
      await references[1].trigger('click')
      expect(previewRequests).toEqual([
        {
          path: '/Users/zeeland/projects/rudder-oss/heartbeat.release.ts',
          fileName: 'heartbeat.release.ts',
          previewOnly: true,
          startLine: 550,
          endLine: 550,
        },
        {
          path: '/Users/zeeland/projects/rudder-oss/issues.ts',
          fileName: 'issues.ts',
          previewOnly: true,
          startLine: 354,
          endLine: 381,
        },
      ])
    } finally {
      wrapper.unmount()
      window.removeEventListener('hermes:preview-workspace-file', handlePreview)
    }
  })

  it('normalizes reversed line ranges to the starting line', async () => {
    const previewRequests: Array<{ path: string; fileName: string; previewOnly?: boolean; startLine?: number; endLine?: number }> = []
    const handlePreview = (event: Event) => {
      const customEvent = event as CustomEvent<(typeof previewRequests)[number]>
      previewRequests.push(customEvent.detail)
      customEvent.preventDefault()
    }
    window.addEventListener('hermes:preview-workspace-file', handlePreview)
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '[reversed.ts:20–10](/tmp/reversed.ts#L20-L10)',
      },
    })

    try {
      await wrapper.get('.markdown-file-link').trigger('click')
      expect(previewRequests).toEqual([{
        path: '/tmp/reversed.ts',
        fileName: 'reversed.ts',
        previewOnly: true,
        startLine: 20,
        endLine: 20,
      }])
    } finally {
      wrapper.unmount()
      window.removeEventListener('hermes:preview-workspace-file', handlePreview)
    }
  })

  it('unwraps existing download URLs before requesting a workspace preview', async () => {
    const previewRequests: Array<{ path: string; fileName: string; previewOnly?: boolean }> = []
    const handlePreview = (event: Event) => {
      const customEvent = event as CustomEvent<(typeof previewRequests)[number]>
      previewRequests.push(customEvent.detail)
      customEvent.preventDefault()
    }
    window.addEventListener('hermes:preview-workspace-file', handlePreview)
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '[notes.txt](/api/studio/files/download?path=%2Ftmp%2Fnotes.txt)',
      },
    })

    try {
      await wrapper.find('.markdown-file-link').trigger('click')
      expect(previewRequests).toEqual([{
        path: '/tmp/notes.txt',
        fileName: 'notes.txt',
        previewOnly: true,
      }])
    } finally {
      window.removeEventListener('hermes:preview-workspace-file', handlePreview)
    }
  })

  it('preserves target extensions while routing markdown previews through the workspace panel', async () => {
    const previewRequests: Array<{ path: string; fileName: string; previewOnly?: boolean }> = []
    const handlePreview = (event: Event) => {
      const customEvent = event as CustomEvent<(typeof previewRequests)[number]>
      previewRequests.push(customEvent.detail)
      customEvent.preventDefault()
    }
    window.addEventListener('hermes:preview-workspace-file', handlePreview)
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '[下载报告](/tmp/report.md)',
      },
    })

    try {
      await wrapper.find('.markdown-file-link').trigger('click')
      expect(previewRequests).toEqual([{
        path: '/tmp/report.md',
        fileName: 'report.md',
        previewOnly: true,
      }])
      expect(wrapper.find('.n-drawer-stub').exists()).toBe(false)
    } finally {
      window.removeEventListener('hermes:preview-workspace-file', handlePreview)
    }
  })

  it('keeps tilde-fenced markdown examples with nested tilde fences intact', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: [
          '```md',
          '## Tilde Example',
          '',
          '~~~md',
          '~~~yaml',
          'ok: true',
          '~~~',
          '~~~',
          '',
          'Done outside.',
          '```',
        ].join('\n'),
      },
    })

    expect(wrapper.find('.markdown-body').find('h2').text()).toBe('Tilde Example')
    expect(wrapper.findAll('.hljs-code-block')).toHaveLength(1)
    expect(wrapper.find('code.hljs').text()).toContain('~~~yaml\nok: true\n~~~')
    expect(wrapper.find('.markdown-body').text()).toContain('Done outside.')
  })

  it('keeps already-valid longer markdown example fences valid', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: [
          '```md',
          '## Longer Fence Example',
          '',
          '````md',
          '```ts',
          'const answer = 42',
          '```',
          '````',
          '',
          'Done outside.',
          '```',
        ].join('\n'),
      },
    })

    expect(wrapper.find('.markdown-body').find('h2').text()).toBe('Longer Fence Example')
    expect(wrapper.findAll('.hljs-code-block')).toHaveLength(1)
    expect(wrapper.find('code.hljs').text()).toContain('```ts\nconst answer = 42\n```')
    expect(wrapper.find('.markdown-body').text()).toContain('Done outside.')
  })

  it('renders mermaid fences as diagrams instead of raw highlighted code', async () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: [
          '```mermaid',
          'flowchart TD',
          'A[User] --> B[Web UI<br/>command]',
          '```',
          '',
          '具体 behavior:',
          '- Markdown below still renders.',
        ].join('\n'),
      },
    })

    await flushMermaidRender()

    expect(mermaidMock.initialize).toHaveBeenCalledWith(expect.objectContaining({
      startOnLoad: false,
      securityLevel: 'strict',
    }))
    expect(mermaidMock.render).toHaveBeenCalledWith(
      expect.stringMatching(/^hermes-mermaid-/),
      expect.stringContaining('flowchart TD'),
    )
    expect(wrapper.find('[data-testid="mermaid-svg"]').exists()).toBe(true)
    expect(wrapper.findAll('.hljs-code-block')).toHaveLength(0)
    expect(wrapper.find('.markdown-body').find('ul').exists()).toBe(true)
  })

  it('renders mermaid inside repaired outer markdown draft fences', async () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: [
          '```md',
          '## Command flow',
          '',
          '```Mermaid title',
          'flowchart LR',
          'A --> B',
          '```',
          '',
          'Done outside.',
          '```',
        ].join('\n'),
      },
    })

    await flushMermaidRender()

    expect(wrapper.find('.markdown-body').find('h2').text()).toBe('Command flow')
    expect(mermaidMock.render).toHaveBeenCalledWith(
      expect.stringMatching(/^hermes-mermaid-/),
      expect.stringContaining('flowchart LR'),
    )
    expect(wrapper.find('[data-testid="mermaid-svg"]').exists()).toBe(true)
    expect(wrapper.find('.markdown-body').text()).toContain('Done outside.')
  })

  it('re-renders existing diagrams when Studio colors change without replacing the surrounding content', async () => {
    const wrapper = mount(MarkdownRenderer, { props: { content: 'Before\n\n```mermaid\nflowchart LR\nA --> B\n```\n\nAfter' } })
    await flushMermaidRender()
    document.documentElement.style.setProperty('--text-primary', '#123456')
    document.dispatchEvent(new CustomEvent('studio-theme-change'))
    await flushMermaidRender()
    expect(mermaidMock.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'base', themeVariables: expect.objectContaining({ primaryTextColor: '#123456' }) }))
    expect(wrapper.find('[data-testid="mermaid-svg"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Before')
    expect(wrapper.text()).toContain('After')
    wrapper.unmount()
    document.documentElement.style.removeProperty('--text-primary')
  })

  it('falls back to a copyable code block when mermaid rendering fails', async () => {
    mermaidMock.render.mockImplementationOnce((id: string) => {
      const errorContainer = document.createElement('div')
      errorContainer.id = `d${id}`
      errorContainer.textContent = 'Syntax error in text\nmermaid version 11.14.0'
      document.body.appendChild(errorContainer)
      return Promise.reject(new Error('bad diagram'))
    })
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '```mermaid\nnot valid mermaid\n```',
      },
    })

    await flushMermaidRender()

    expect(wrapper.find('[data-testid="mermaid-svg"]').exists()).toBe(false)
    expect(wrapper.find('.hljs-code-block').exists()).toBe(true)
    expect(wrapper.find('.code-lang').text()).toBe('mermaid')
    expect(wrapper.find('code.hljs').text()).toContain('not valid mermaid')
    expect(wrapper.find('[data-copy-code="true"]').exists()).toBe(true)
    expect(document.body.textContent).not.toContain('Syntax error in text')
  })

  it('falls back to copyable code blocks when mermaid initialization fails', async () => {
    mermaidMock.initialize.mockImplementationOnce(() => {
      throw new Error('init failed')
    })

    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '```mermaid\nflowchart TD\nA --> B\n```',
      },
    })

    await flushMermaidRender()

    expect(mermaidMock.render).not.toHaveBeenCalled()
    expect(wrapper.find('.hljs-code-block').exists()).toBe(true)
    expect(wrapper.find('.code-lang').text()).toBe('mermaid')
    expect(wrapper.find('code.hljs').text()).toContain('flowchart TD')
  })

  it('falls back without initializing mermaid when every pending diagram is oversized', async () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: `\`\`\`mermaid\n${'A'.repeat(20_001)}\n\`\`\``,
      },
    })

    await flushMermaidRender()

    expect(mermaidMock.initialize).not.toHaveBeenCalled()
    expect(mermaidMock.render).not.toHaveBeenCalled()
    expect(wrapper.find('.hljs-code-block').exists()).toBe(true)
    expect(wrapper.find('.code-lang').text()).toBe('mermaid')
  })

  it('falls back without initializing mermaid when every pending diagram is empty', async () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '```mermaid\n```',
      },
    })

    await flushMermaidRender()

    expect(mermaidMock.initialize).not.toHaveBeenCalled()
    expect(mermaidMock.render).not.toHaveBeenCalled()
    expect(wrapper.find('.hljs-code-block').exists()).toBe(true)
    expect(wrapper.find('.code-lang').text()).toBe('mermaid')
  })

  it('falls back to copyable code when mermaid rendering never settles', async () => {
    vi.useFakeTimers()
    mermaidMock.render.mockImplementationOnce(() => new Promise(() => {}))

    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '```mermaid\nflowchart TD\nA --> B\n```',
      },
    })

    await nextTick()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(5_001)
    await flushMermaidRender()

    expect(wrapper.find('.mermaid-loading').exists()).toBe(false)
    expect(wrapper.find('[data-testid="mermaid-svg"]').exists()).toBe(false)
    expect(wrapper.find('.hljs-code-block').exists()).toBe(true)
    expect(wrapper.find('.code-lang').text()).toBe('mermaid')
    expect(wrapper.find('code.hljs').text()).toContain('flowchart TD')
  })

  it('does not load or render mermaid when the message has no mermaid block', async () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '```ts\nconst answer = 42\n```',
      },
    })

    await flushMermaidRender()

    expect(mermaidMock.initialize).not.toHaveBeenCalled()
    expect(mermaidMock.render).not.toHaveBeenCalled()
    expect(wrapper.find('.code-lang').text()).toBe('ts')
  })

  it('does not let stale async mermaid renders mutate newer message content', async () => {
    let resolveRender: ((value: { svg: string }) => void) | undefined
    mermaidMock.render.mockImplementationOnce((id: string) => new Promise(resolve => {
      resolveRender = resolve
    }))

    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '```mermaid\nflowchart TD\nA --> B\n```',
      },
    })

    await nextTick()
    await wrapper.setProps({ content: 'No diagram now.' })
    resolveRender?.({ svg: '<svg data-testid="stale-mermaid-svg"></svg>' })
    await flushMermaidRender()

    expect(wrapper.find('[data-testid="stale-mermaid-svg"]').exists()).toBe(false)
    expect(wrapper.find('.markdown-body').text()).toContain('No diagram now.')
  })

  it('renders inline latex math with katex', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: 'Pythagoras: $x^2 + y^2 = z^2$.',
      },
    })

    const body = wrapper.find('.markdown-body')
    expect(body.find('.katex').exists()).toBe(true)
    expect(body.html()).toContain('x')
    expect(body.html()).toContain('z')
    expect(body.text()).not.toContain('$x^2 + y^2 = z^2$')
  })

  it('renders display latex math with katex', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '$$\n\\int_0^1 x^2 dx = \\frac{1}{3}\n$$',
      },
    })

    const body = wrapper.find('.markdown-body')
    expect(body.find('.katex-display').exists()).toBe(true)
    expect(body.find('.katex').exists()).toBe(true)
    expect(body.text()).not.toContain('$$')
  })

  it('renders explicit latex fenced blocks with katex', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '```latex\n\\[\\text{Итог} = \\operatorname{Округление}\\!\\left(0.5\\,O_1 + 0.5\\,O_2\\right)\\]\n```',
      },
    })

    const body = wrapper.find('.markdown-body')
    expect(body.find('.katex-display').exists()).toBe(true)
    expect(body.find('.katex').exists()).toBe(true)
    expect(body.text()).not.toContain('```latex')
    expect(body.text()).toContain('Округление')
  })

  it('does not render latex inside ordinary fenced code blocks', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '```ts\nconst formula = "$x^2 + y^2 = z^2$"\n```',
      },
    })

    expect(wrapper.find('.markdown-body').find('.katex').exists()).toBe(false)
    expect(wrapper.find('code.hljs').text()).toContain('$x^2 + y^2 = z^2$')
  })

  it('does not treat currency-like dollar text as latex math', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: 'Price is $5 and $6 today.',
      },
    })

    const body = wrapper.find('.markdown-body')
    expect(body.find('.katex').exists()).toBe(false)
    expect(body.text()).toContain('Price is $5 and $6 today.')
  })

  it('does not render escaped dollar-delimited text as latex math', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: 'Escaped: \\$x^2$',
      },
    })

    const body = wrapper.find('.markdown-body')
    expect(body.find('.katex').exists()).toBe(false)
    expect(body.text()).toContain('Escaped: $x^2$')
  })

  it('keeps rendering when latex syntax is invalid', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: 'Before $\\notacommand{ after',
      },
    })

    expect(wrapper.find('.markdown-body').text()).toContain('Before')
  })

  it('copies code through the delegated click handler', async () => {
    const writeText = vi.mocked(navigator.clipboard.writeText)
    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '```ts\nconst answer = 42\n```',
      },
    })

    const expected = wrapper.find('code.hljs').element.textContent ?? ''
    await wrapper.find('[data-copy-code="true"]').trigger('click')

    expect(writeText).toHaveBeenCalledWith(expected)
  })

  it('falls back to legacy clipboard copy when the Clipboard API is unavailable', async () => {
    Object.defineProperty(window, 'isSecureContext', {
      configurable: true,
      value: false,
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })
    const execCommand = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    })

    const wrapper = mount(MarkdownRenderer, {
      props: {
        content: '```ts\nconst answer = 42\n```',
      },
    })

    await wrapper.find('[data-copy-code="true"]').trigger('click')

    expect(execCommand).toHaveBeenCalledWith('copy')
  })
})
