<script setup lang="ts">
import 'katex/dist/katex.min.css'
import { stripToolCallMarkup } from '../../../../../shared/tool-call-markup'
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, unref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import type MarkdownIt from 'markdown-it'
import MarkdownItConstructor from 'markdown-it'
import katex from 'katex'
import markdownItKatex from '@vscode/markdown-it-katex'
import { handleCodeBlockCopyClick, renderHighlightedCodeBlock } from './highlight'
import { repairNestedMarkdownFences } from './markdownFenceRepair'
import {
  MERMAID_MAX_DIAGRAMS_PER_MESSAGE,
  MERMAID_MAX_SOURCE_LENGTH,
  MERMAID_RENDER_TIMEOUT_MS,
  decodeMermaidSource,
  isMermaidFence,
  renderMermaidPlaceholder,
} from './mermaidRenderer'
import { downloadFile, getDownloadUrl, inferDownloadFileName } from '@/api/studio/download'
import { getBaseUrlValue } from '@/api/client'
import { isPreviewableFile } from '@/utils/hermes/file-preview'
import { openUrlInDesktopBrowser } from '@/utils/desktop-browser'
import ImagePreviewOverlay from './ImagePreviewOverlay.vue'

const LATEX_FENCE_LANGS = new Set(['latex', 'tex', 'math', 'katex'])
function getFenceLanguage(info: string): string {
  return info.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
}

function isLatexFence(info: string): boolean {
  return LATEX_FENCE_LANGS.has(getFenceLanguage(info))
}

function normalizeLatexFenceContent(content: string): string {
  const trimmed = content.trim()

  if (trimmed.startsWith('\\[') && trimmed.endsWith('\\]')) {
    return trimmed.slice(2, -2).trim()
  }

  if (trimmed.startsWith('$$') && trimmed.endsWith('$$')) {
    return trimmed.slice(2, -2).trim()
  }

  if (trimmed.startsWith('\\(') && trimmed.endsWith('\\)')) {
    return trimmed.slice(2, -2).trim()
  }

  return trimmed
}

function renderLatexFence(content: string): string {
  const latex = normalizeLatexFenceContent(content)
  return `<div class="latex-block">${katex.renderToString(latex, {
    displayMode: true,
    output: 'htmlAndMathml',
    throwOnError: false,
    strict: 'ignore',
  })}</div>`
}

const props = withDefaults(defineProps<{
    content: string
    mentionNames?: string[]
    headingIdPrefix?: string
    resolveImageUrl?: (path: string) => string
    deferImages?: boolean
}>(), {
    mentionNames: () => [],
    headingIdPrefix: '',
})

const { t } = useI18n()
const message = useMessage()
const workspaceFilePreviewCapability = inject<boolean | Ref<boolean>>('hermesWorkspaceFilePreview', false)
const workspaceFilePreviewAvailable = computed(() => unref(workspaceFilePreviewCapability))

function diffFoldLabel(hiddenCount: number): string {
  return t('chat.unchangedLines', { count: hiddenCount })
}

const md: MarkdownIt = new MarkdownItConstructor({
  html: false,
  breaks: true,
  linkify: true,
  typographer: true,
  highlight(str: string, lang: string): string {
    return renderHighlightedCodeBlock(str, lang, t('common.copy'), {
      formatDiffFoldLabel: diffFoldLabel,
    })
  },
})

// Preserve literal quote characters from user and assistant messages while
// retaining typographer's other replacements (for example, dashes and ellipses).
md.disable('smartquotes')
// Bare source filenames such as DESIGN.md overlap real domain suffixes.
// Explicit URLs and email addresses still use markdown-it's linkifier.
md.linkify.set({ fuzzyLink: false })

md.use(markdownItKatex, {
  katex,
  throwOnError: false,
  strict: 'ignore',
})

// A conversation carries whatever language the person writes in, and one
// message can hold both. dir="auto" lets each block pick its own direction from
// its first strong character, so an Arabic paragraph reads right-to-left even
// while the interface is in English — and the reverse.
const AUTO_DIRECTION_TOKENS = new Set([
  'paragraph_open',
  'heading_open',
  'blockquote_open',
  'list_item_open',
  'th_open',
  'td_open',
  'dt_open',
  'dd_open',
])

md.core.ruler.push('auto_direction', (state) => {
  for (const token of state.tokens) {
    if (AUTO_DIRECTION_TOKENS.has(token.type)) token.attrSet('dir', 'auto')
  }
})

const defaultFenceRenderer = md.renderer.rules.fence?.bind(md.renderer.rules)

md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  if (isLatexFence(token.info)) {
    return renderLatexFence(token.content)
  }

  if (isMermaidFence(token.info)) {
    return renderMermaidPlaceholder(token.content)
  }

  if (defaultFenceRenderer) {
    return defaultFenceRenderer(tokens, idx, options, env, self)
  }

  return self.renderToken(tokens, idx, options)
}

const markdownBody = ref<HTMLElement | null>(null)
const componentId = `hermes-mermaid-${Math.random().toString(36).slice(2)}`
const previewUrl = ref<string | null>(null)

let renderGeneration = 0
let unmounted = false

function isLocalFilePath(path: string): boolean {
  return (path.startsWith('/') && !path.startsWith('//')) || /^[a-zA-Z]:[\\/]/.test(path)
}

function normalizeLocalFilePath(path: string): string {
  return /^[a-zA-Z]:\\/.test(path) ? path.replace(/\\/g, '/') : path
}

type LocalFileLocation = {
  path: string
  startLine?: number
  endLine?: number
}

function positiveSafeLine(value: string | undefined): number | undefined {
  if (!value) return undefined
  const line = Number(value)
  return Number.isSafeInteger(line) && line > 0 ? line : undefined
}

function parseLocalFileLocation(path: string): LocalFileLocation {
  const normalizedPath = normalizeLocalFilePath(path)
  const hashLocationMatch = normalizedPath.match(/^(.*?)#L(\d+)(?:-L?(\d+))?$/i)
  if (hashLocationMatch && isLocalFilePath(hashLocationMatch[1])) {
    const startLine = positiveSafeLine(hashLocationMatch[2])
    if (!startLine) return { path: hashLocationMatch[1] }
    const requestedEndLine = positiveSafeLine(hashLocationMatch[3])
    return {
      path: hashLocationMatch[1],
      startLine,
      endLine: requestedEndLine && requestedEndLine >= startLine ? requestedEndLine : startLine,
    }
  }
  const locationMatch = normalizedPath.match(/^(.*?):(\d+)(?:-(\d+)|:(\d+))?$/)
  if (!locationMatch || !isLocalFilePath(locationMatch[1])) return { path: normalizedPath }
  const startLine = positiveSafeLine(locationMatch[2])
  if (!startLine) return { path: locationMatch[1] }
  const requestedEndLine = positiveSafeLine(locationMatch[3])
  return {
    path: locationMatch[1],
    startLine,
    endLine: requestedEndLine && requestedEndLine >= startLine ? requestedEndLine : startLine,
  }
}

function requestWorkspaceFilePreview(
  path: string,
  fileName: string,
  previewOnly = false,
  startLine?: number,
  endLine?: number,
): boolean {
  const event = new CustomEvent('hermes:preview-workspace-file', {
    cancelable: true,
    detail: {
      path,
      fileName,
      ...(previewOnly ? { previewOnly: true } : {}),
      ...(startLine ? { startLine, endLine: endLine || startLine } : {}),
    },
  })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

function downloadPathFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url, window.location.origin)
    if (parsed.pathname !== '/api/studio/files/download') return null
    const configuredApiOrigin = new URL(getBaseUrlValue() || window.location.origin, window.location.origin).origin
    if (parsed.origin !== window.location.origin && parsed.origin !== configuredApiOrigin) return null
    const path = parsed.searchParams.get('path')
    return path ? `${path}${parsed.hash}` : null
  } catch {
    return null
  }
}

function localFileTargetFromRenderedHref(rawHref: string): string {
  const href = md.utils.unescapeAll(rawHref)
  let target = downloadPathFromUrl(href) || href
  try { target = decodeURIComponent(target) } catch { /* Keep malformed percent sequences literal. */ }
  return normalizeLocalFilePath(target)
}

function renderedLinkText(innerHtml: string): string {
  return md.utils.unescapeAll(innerHtml.replace(/<[^>]+>/g, '')).trim()
}

const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v'])
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'])

function hasExtension(path: string, extensions: Set<string>): boolean {
  const clean = path.split('?')[0].split('#')[0]
  const ext = clean.split('.').pop()?.toLowerCase()
  return !!ext && extensions.has(ext)
}

const renderedHtml = computed(() => {
  let html = md.render(repairNestedMarkdownFences(stripToolCallMarkup(props.content)))
  if (props.deferImages) html = html.replace(/<img\b[^>]*>/gi, '')

  // Add IDs to headings for anchor links
  const prefix = props.headingIdPrefix ? `${props.headingIdPrefix}-` : ''
  let headingCounter = 0
  // Match any h1-h6 tags, with or without attributes
  html = html.replace(/<(h[1-6])([^>]*)>/g, (match, tag, attrs) => {
    headingCounter++
    const id = `${prefix}heading-${headingCounter}`
    
    // Check if id attribute already exists
    if (attrs.includes('id=')) {
      // Replace existing id
      return match.replace(/id="[^"]*"/, `id="${id}"`).replace(/id='[^']*'/, `id="${id}"`)
    }
    
    // Add new id
    if (attrs.trim() === '') {
      return `<${tag} id="${id}">`
    }
    return `<${tag} ${attrs.trim()} id="${id}">`
  })

  // Replace image src paths with download URLs
  html = html.replace(/\bsrc=(["'])([^"']+)\1/g, (match, quote, path) => {
    if (!isLocalFilePath(path)) return match
    if (props.resolveImageUrl && !path.startsWith('//')) {
      let decodedPath = md.utils.unescapeAll(path)
      try { decodedPath = decodeURIComponent(decodedPath) } catch { /* Keep literal paths. */ }
      return `src="${md.utils.escapeHtml(props.resolveImageUrl(normalizeLocalFilePath(decodedPath)))}"`
    }
    const downloadUrl = getDownloadUrl(normalizeLocalFilePath(path))
    return `src=${quote}${downloadUrl}${quote}`
  })

  // Replace local file links with preview links, download cards, or media players.
  // Match optional title attributes and rich labels such as **file.ts** or `file.ts`.
  html = html.replace(/<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, (match, rawHref, innerHtml) => {
    const target = localFileTargetFromRenderedHref(rawHref)
    if (!isLocalFilePath(target)) return match

    const location = parseLocalFileLocation(target)
    const { path } = location
    const fileName = renderedLinkText(innerHtml)
    const downloadName = inferDownloadFileName(path, fileName)

    // Media already has an immediate inline preview and is not presented as a
    // downloadable document, so keep the player instead of opening source view.
    if (hasExtension(path, VIDEO_EXTENSIONS)) {
      const downloadUrl = getDownloadUrl(path)
      return `<div class="markdown-video-container">
        <video class="markdown-video" controls preload="metadata" src="${downloadUrl}"></video>
        <div class="markdown-video-footer">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
          <span class="att-name">${innerHtml}</span>
        </div>
      </div>`
    }

    // Audio files: render as inline audio player
    if (hasExtension(path, AUDIO_EXTENSIONS)) {
      const downloadUrl = getDownloadUrl(path)
      return `<div class="markdown-audio-container">
        <audio class="markdown-audio" controls preload="metadata" src="${downloadUrl}"></audio>
        <div class="markdown-audio-footer">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M9 18V5l12-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="16" r="3" />
          </svg>
          <span class="att-name">${innerHtml}</span>
        </div>
      </div>`
    }

    if (workspaceFilePreviewAvailable.value && isPreviewableFile(downloadName)) {
      const previewHref = location.startLine
        ? `${path}#L${location.startLine}${location.endLine && location.endLine !== location.startLine ? `-L${location.endLine}` : ''}`
        : path
      return `<a class="markdown-file-link" href="${md.utils.escapeHtml(previewHref)}" title="${md.utils.escapeHtml(t('files.preview'))}">${innerHtml}</a>`
    }

    // Files without an in-app renderer retain the explicit download card.
    const downloadLabel = md.utils.escapeHtml(t('download.downloadFile'))
    return `<button class="markdown-file-card" type="button" data-path="${md.utils.escapeHtml(path)}" data-filename="${md.utils.escapeHtml(downloadName)}" title="${downloadLabel}" aria-label="${downloadLabel}: ${md.utils.escapeHtml(downloadName)}">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
      <span class="att-name">${innerHtml}</span>
      <svg class="att-download-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    </button>`
  })

  if (props.mentionNames && props.mentionNames.length > 0) {
    const escaped = [...props.mentionNames]
      .sort((a, b) => b.length - a.length)
      .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const re = new RegExp(`(?<=[\\s>({\\[<]|^)@(${escaped.join('|')})(?=[\\s.,!?;:，。！？；：)\\]}>]|<|$)`, 'gi')
    html = html.replace(re, '<span class="mention-highlight">@$1</span>')
  }
  return html
})

function renderMermaidFallback(element: HTMLElement, source: string): void {
  element.outerHTML = renderHighlightedCodeBlock(source, 'mermaid', t('common.copy'))
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId)
    }
  })
}

function getScrollParent(el: HTMLElement | null): HTMLElement | null {
  if (!el) return null
  let current: HTMLElement | null = el.parentElement
  while (current) {
    const { overflow, overflowY } = getComputedStyle(current)
    if (overflow === 'auto' || overflow === 'scroll' || overflowY === 'auto' || overflowY === 'scroll') {
      return current
    }
    current = current.parentElement
  }
  return null
}

function isNearScrollBottom(el: HTMLElement, threshold = 200): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold
}

function cleanupMermaidRenderArtifacts(id: string): void {
  document.getElementById(id)?.remove()
  document.getElementById(`d${id}`)?.remove()
}

async function renderMermaidDiagrams(): Promise<void> {
  const generation = ++renderGeneration
  await nextTick()

  const root = markdownBody.value
  if (unmounted || generation !== renderGeneration || !root) return

  const pendingDiagrams = Array.from(root.querySelectorAll<HTMLElement>('[data-mermaid-pending="true"]'))
  if (pendingDiagrams.length === 0) return

  const diagramsToRender = pendingDiagrams.slice(0, MERMAID_MAX_DIAGRAMS_PER_MESSAGE)
  const diagramsToFallback = pendingDiagrams.slice(MERMAID_MAX_DIAGRAMS_PER_MESSAGE)

  for (const element of diagramsToFallback) {
    renderMermaidFallback(element, decodeMermaidSource(element.getAttribute('data-mermaid-source')))
  }

  const renderCandidates = diagramsToRender
    .map(element => ({
      element,
      source: decodeMermaidSource(element.getAttribute('data-mermaid-source')),
    }))

  const validDiagrams = [] as typeof renderCandidates
  for (const candidate of renderCandidates) {
    if (unmounted || generation !== renderGeneration || !root.contains(candidate.element)) return

    if (!candidate.source || candidate.source.length > MERMAID_MAX_SOURCE_LENGTH) {
      renderMermaidFallback(candidate.element, candidate.source)
      continue
    }

    validDiagrams.push(candidate)
  }

  if (validDiagrams.length === 0) return

  let mermaid: typeof import('mermaid').default

  try {
    mermaid = (await withTimeout(import('mermaid'), MERMAID_RENDER_TIMEOUT_MS, 'Mermaid import')).default
    if (unmounted || generation !== renderGeneration) return

    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: mermaidThemeVariables(),
    })
  } catch {
    if (unmounted || generation !== renderGeneration) return
    for (const { element, source } of validDiagrams) {
      if (root.contains(element)) {
        renderMermaidFallback(element, source)
      }
    }
    return
  }

  for (const [index, { element, source }] of validDiagrams.entries()) {
    if (unmounted || generation !== renderGeneration || !root.contains(element)) return

    try {
      const id = `${componentId}-${generation}-${index}`
      const result = await withTimeout(mermaid.render(id, source), MERMAID_RENDER_TIMEOUT_MS, 'Mermaid render')
      cleanupMermaidRenderArtifacts(id)
      if (unmounted || generation !== renderGeneration || !root.contains(element)) return

      const scrollParent = getScrollParent(markdownBody.value)
      const shouldKeepBottom = scrollParent ? isNearScrollBottom(scrollParent) : false
      element.removeAttribute('data-mermaid-pending')
      element.innerHTML = result.svg
      if (scrollParent && shouldKeepBottom) {
        nextTick(() => {
          scrollParent.scrollTop = scrollParent.scrollHeight
        })
      }
    } catch {
      cleanupMermaidRenderArtifacts(`${componentId}-${generation}-${index}`)
      if (unmounted || generation !== renderGeneration || !root.contains(element)) return
      renderMermaidFallback(element, source)
    }
  }
}

function mermaidThemeVariables() {
  const root = document.documentElement
  const css = getComputedStyle(root)
  const dark = root.classList.contains('dark')
  const color = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
  return {
    darkMode: dark,
    background: color('--bg-primary', dark ? '#1a1a1a' : '#fafafa'),
    primaryColor: color('--bg-card', dark ? '#2a2a2a' : '#ffffff'),
    primaryTextColor: color('--text-primary', dark ? '#e0e0e0' : '#1a1a1a'),
    primaryBorderColor: color('--border-color', dark ? '#3a3a3a' : '#e0e0e0'),
    lineColor: color('--accent-primary', dark ? '#e0e0e0' : '#333333'),
    fontFamily: color('--font-ui', 'system-ui, sans-serif'),
    fontSize: color('--font-size-base', '14px'),
  }
}

function refreshMermaidTheme() {
  const diagrams = markdownBody.value?.querySelectorAll('[data-mermaid-source]')
  if (!diagrams?.length) return
  diagrams.forEach(element => element.setAttribute('data-mermaid-pending', 'true'))
  void renderMermaidDiagrams()
}

onMounted(() => {
  document.addEventListener('studio-theme-change', refreshMermaidTheme)
  void renderMermaidDiagrams()
})

watch(renderedHtml, () => {
  void renderMermaidDiagrams()
}, { flush: 'post' })

onBeforeUnmount(() => {
  document.removeEventListener('studio-theme-change', refreshMermaidTheme)
  unmounted = true
  renderGeneration += 1
})

async function handleMarkdownClick(event: MouseEvent): Promise<void> {
  const target = event.target as HTMLElement
  const link = target.closest('a') as HTMLAnchorElement | null
  const href = link?.getAttribute('href') || ''
  const isWebLink = /^(?:https?:)?\/\//i.test(href)
  const webUrl = href.startsWith('//') ? `${window.location.protocol}${href}` : href
  const isLocalLink = isLocalFilePath(href) || href.startsWith('/api/studio/files/download?')

  // Native anchor navigation happens as soon as this async listener yields, so
  // cancel all links handled below before the first await.
  if (isWebLink || isLocalLink) {
    event.preventDefault()
    if (isLocalLink) event.stopPropagation()
  }

  const copyResult = await handleCodeBlockCopyClick(event)
  if (copyResult !== null) {
    if (copyResult) {
      message.success(t('common.copied'))
    } else {
      message.error(t('chat.copyFailed'))
    }
    return
  }

  // Handle image clicks for preview
  const img = target.closest('img') as HTMLImageElement | null
  if (img) {
    event.preventDefault()
    previewUrl.value = img.src
    return
  }

  // Handle file card clicks for download
  const fileCard = target.closest('.markdown-file-card') as HTMLElement | null
  if (fileCard) {
    event.preventDefault()
    event.stopPropagation()
    const path = fileCard.getAttribute('data-path')
    const fileName = fileCard.getAttribute('data-filename') || undefined
    if (path) {
      message.info(t('download.downloading'))
      downloadFile(path, fileName).catch((err: Error) => {
        message.error(err.message || t('download.downloadFailed'))
      })
    }
    return
  }

  // Handle ordinary links after cards, copy controls, and image overlays.
  if (!link) return
  if (!href) return

  // Desktop links use the configured destination. Web deployments keep using a
  // separate browser tab so the hash-based router cannot intercept.
  if (isWebLink) {
    try {
      if (await openUrlInDesktopBrowser(webUrl)) return
    } catch (error) {
      message.error(`${t('browser.loadFailed')}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    window.open(webUrl, '_blank', 'noopener,noreferrer')
    return
  }

  // Full download URL: open directly (already has /api/studio/files/download?path=...)
  if (href.startsWith('/api/studio/files/download?')) {
    event.preventDefault()
    event.stopPropagation()
    const linkText = link.textContent || ''
    const fileName = linkText.startsWith('File: ') ? linkText.slice(6).trim() : linkText.trim()
    message.info(t('download.downloading'))
    // Parse the real file path from the existing query param
    const url = new URL(href, window.location.origin)
    const realPath = url.searchParams.get('path') || href
    downloadFile(realPath, inferDownloadFileName(realPath, fileName || undefined)).catch((err: Error) => {
      message.error(err.message || t('download.downloadFailed'))
    })
    return
  }

  // Preview-capable local links open in the host panel. Contexts without a
  // preview host render download cards earlier, while unsupported links keep
  // the explicit download fallback here.
  if (isLocalFilePath(href)) {
    event.preventDefault()
    event.stopPropagation()
    const linkText = link.textContent || ''
    const fileName = linkText.startsWith('File: ') ? linkText.slice(6).trim() : linkText.trim()
    const location = parseLocalFileLocation(href)
    const { path } = location
    const downloadName = inferDownloadFileName(path, fileName || undefined)
    if (isPreviewableFile(downloadName)) {
      if (!requestWorkspaceFilePreview(path, downloadName, true, location.startLine, location.endLine)) {
        message.error(t('files.previewFailed'))
      }
      return
    }
    message.info(t('download.downloading'))
    downloadFile(path, downloadName).catch((err: Error) => {
      message.error(err.message || t('download.downloadFailed'))
    })
  }
}

</script>

<template>
  <div ref="markdownBody" class="markdown-body" dir="auto" v-html="renderedHtml" @click="handleMarkdownClick"></div>
  <ImagePreviewOverlay
    v-if="previewUrl"
    :src="previewUrl"
    alt=""
    @close="previewUrl = null"
  />
</template>

<style lang="scss">
@use '@/styles/variables' as *;

.markdown-body {
  // Code keeps its own direction whatever language surrounds it: a snippet
  // inside an Arabic sentence must not be mirrored.
  pre,
  code,
  kbd,
  samp {
    direction: ltr;
    unicode-bidi: isolate;
    text-align: start;
  }

  font-size: var(--font-size-base);
  line-height: var(--line-height, 1.65);
  width: 100%;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
  overflow-x: auto;
  overflow-wrap: anywhere;
  word-break: break-word;

  p {
    margin: 0 0 8px;
    min-width: 0;
    max-width: 100%;
    overflow-wrap: anywhere;

    &:last-child {
      margin-bottom: 0;
    }
  }

  ul, ol {
    padding-inline-start: calc(20px * var(--spacing-scale, 1));
    margin: 4px 0 8px;
  }

  li {
    margin: 2px 0;
    min-width: 0;
    max-width: 100%;
    overflow-wrap: anywhere;
  }

  strong {
    color: $text-primary;
    font-weight: 600;
  }

  em {
    color: $text-secondary;
  }

  a {
    color: $accent-primary;
    text-decoration: underline;
    text-underline-offset: 2px;
    overflow-wrap: anywhere;
    word-break: break-word;

    &:hover {
      color: $accent-hover;
    }
  }

  a.markdown-file-link {
    color: $text-secondary;
    font-weight: 500;
    text-decoration-line: underline;
    text-decoration-style: dotted;
    text-decoration-thickness: 1px;
    text-decoration-color: $text-muted;
    text-underline-offset: 3px;
    cursor: pointer;
    transition: color 0.15s ease, text-decoration-color 0.15s ease;

    &:hover,
    &:focus-visible {
      color: $text-primary;
      text-decoration-color: var(--accent-primary);
    }

    code:not(.hljs) {
      padding: 0;
      border-radius: 0;
      color: inherit;
      background: transparent;
      font: inherit;
      white-space: inherit;
    }
  }

  img {
    display: block;
    max-width: 200px;
    max-height: 160px;
    object-fit: contain;
    cursor: pointer;
    border-radius: var(--radius-component, 4px);
    margin: 8px 0;
  }

  .markdown-video-container {
    margin: 12px 0;
    border-radius: $radius-sm;
    overflow: hidden;
    background: #000;
    border: var(--border-width, 1px) solid $border-color;
  }

  .markdown-video {
    display: block;
    width: 100%;
    max-width: 640px;
    max-height: 480px;
    object-fit: contain;
  }

  .markdown-video-footer {
    display: flex;
    align-items: center;
    gap: calc(8px * var(--spacing-scale, 1));
    padding: calc(8px * var(--spacing-scale, 1)) calc(12px * var(--spacing-scale, 1));
    background: rgba(0, 0, 0, 0.85);
    color: #fff;
    font-size: calc(var(--font-size-base, 14px) * 12 / 14);

    .att-name {
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  }

  .markdown-audio-container {
    margin: 12px 0;
    padding: calc(10px * var(--spacing-scale, 1)) calc(12px * var(--spacing-scale, 1));
    border: var(--border-width, 1px) solid $border-light;
    border-radius: $radius-sm;
    background-color: rgba(0, 0, 0, 0.04);
  }

  .markdown-audio {
    display: block;
    width: 100%;
    max-width: 420px;
  }

  .markdown-audio-footer {
    display: flex;
    align-items: center;
    gap: calc(8px * var(--spacing-scale, 1));
    margin-top: 6px;
    color: $text-secondary;
    font-size: calc(var(--font-size-base, 14px) * 12 / 14);

    .att-name {
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  }

  .markdown-file-card {
    display: inline-flex;
    align-items: center;
    gap: calc(6px * var(--spacing-scale, 1));
    padding: calc(6px * var(--spacing-scale, 1)) calc(10px * var(--spacing-scale, 1));
    font: inherit;
    font-size: calc(var(--font-size-base, 14px) * 12 / 14);
    color: $text-secondary;
    background-color: rgba(0, 0, 0, 0.04);
    border: var(--border-width, 1px) solid $border-light;
    border-radius: $radius-sm;
    margin: 8px 0;
    cursor: pointer;
    text-align: start;
    transition: background-color 0.15s ease, border-color 0.15s ease;

    &:hover,
    &:focus-visible {
      background-color: rgba(0, 0, 0, 0.08);
      border-color: $border-color;
    }

    &:focus-visible {
      outline: 2px solid rgba(var(--accent-primary-rgb), 0.72);
      outline-offset: 2px;
    }

    .att-name {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 160px;
    }

    .att-download-icon {
      flex-shrink: 0;
      opacity: 0.6;
      transition: opacity 0.15s ease;
    }

    &:hover .att-download-icon,
    &:focus-visible .att-download-icon {
      opacity: 1;
    }
  }

  blockquote {
    margin: 8px 0;
    padding: calc(4px * var(--spacing-scale, 1)) calc(12px * var(--spacing-scale, 1));
    border-inline-start: 3px solid $border-color;
    color: $text-secondary;
  }

  code:not(.hljs) {
    background: $code-bg;
    padding: calc(2px * var(--spacing-scale, 1)) calc(6px * var(--spacing-scale, 1));
    border-radius: var(--radius-component, 4px);
    font-family: var(--font-code, $font-code);
    font-size: calc(var(--font-size-base, 14px) * 13 / 14);
    color: $accent-primary;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  table {
    width: 100%;
    max-width: 100%;
    border-collapse: collapse;
    margin: 8px 0;
    display: block;
    overflow-x: auto;

    th, td {
      padding: calc(6px * var(--spacing-scale, 1)) calc(12px * var(--spacing-scale, 1));
      border: var(--border-width, 1px) solid $border-color;
      text-align: start;
      font-size: calc(var(--font-size-base, 14px) * 13 / 14);
    }

    th {
      background: rgba(var(--accent-primary-rgb), 0.08);
      color: $text-primary;
      font-weight: 600;
    }

    td {
      color: $text-secondary;
    }
  }

  hr {
    border: none;
    border-top: var(--border-width, 1px) solid $border-color;
    margin: 12px 0;
  }

  .mermaid-diagram {
    margin: 10px 0;
    padding: calc(14px * var(--spacing-scale, 1));
    border: var(--border-width, 1px) solid $border-color;
    border-radius: var(--radius-component, 8px);
    background: rgba(var(--accent-primary-rgb), 0.04);
    overflow-x: auto;

    svg {
      max-width: 100%;
      height: auto;
      display: block;
      margin: 0 auto;
    }
  }

  .mermaid-loading {
    color: $text-secondary;
    font-size: calc(var(--font-size-base, 14px) * 13 / 14);
    font-family: var(--font-code, $font-code);
    min-height: 60px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
}

</style>
