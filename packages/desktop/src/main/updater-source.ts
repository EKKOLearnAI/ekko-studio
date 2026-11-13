import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PRIMARY_FEED = 'https://tangledup-ai-staging.oss-cn-shanghai.aliyuncs.com/quanthermes_pj/quanthermes_web_ui'
const FALLBACK_FEED = 'https://github.com/tangledup-ai/hermes-web-ui/releases/latest/download'

export function desktopUpdateChannel(platform = process.platform, arch = process.arch): string {
  return platform === 'win32' && arch === 'arm64' ? 'latest-arm64' : 'latest'
}

export type DesktopUpdateSource =
  | { channel: 'stable'; url: string; fallbackUrl: string }
  | { channel: 'test'; url: string }

export function validateTestUpdateUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\t]/.test(value)) {
    throw new Error('A test update feed directory URL is required')
  }
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('Invalid test update feed URL') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Test update feeds require HTTPS without credentials, query parameters or fragments')
  }
  const path = decodeURIComponent(url.pathname).replace(/\/+$/, '').toLowerCase()
  if (path.endsWith('.yml') || path.endsWith('.yaml')) {
    throw new Error('Use the feed directory URL, not the update manifest URL')
  }
  if ((url.hostname === 'tangledup-ai-staging.oss-cn-shanghai.aliyuncs.com' && path.startsWith('/quanthermes_pj/quanthermes_web_ui'))
    || (url.hostname === 'github.com' && path.startsWith('/tangledup-ai/hermes-web-ui/releases'))) {
    throw new Error('The production update source cannot be used for test builds')
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`
  return url.href
}

export function resolveDesktopUpdateSource(metadata: unknown): DesktopUpdateSource {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Invalid desktop package metadata')
  }
  // Only package metadata can select a test feed. No runtime environment or UI
  // setting can switch a production installation to a test server.
  if (!Object.prototype.hasOwnProperty.call(metadata, 'desktopUpdate')) {
    return { channel: 'stable', url: PRIMARY_FEED, fallbackUrl: FALLBACK_FEED }
  }
  const config = (metadata as { desktopUpdate: unknown }).desktopUpdate
  if (!config || typeof config !== 'object' || !('channel' in config) || config.channel !== 'test' || !('url' in config)) {
    throw new Error('Invalid packaged test update configuration; refusing to use production feeds')
  }
  return { channel: 'test', url: validateTestUpdateUrl(config.url) }
}

export function readDesktopUpdateSource(appPath: string): DesktopUpdateSource {
  // Read/parse errors deliberately propagate: broken test metadata must not
  // silently turn a test installation back into a production installation.
  return resolveDesktopUpdateSource(JSON.parse(readFileSync(join(appPath, 'package.json'), 'utf8')))
}
