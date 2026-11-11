import type { PluginManifest } from '../../contracts/plugins'
import { PluginError } from './errors'

function text(value: unknown, label: string, max = 200): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new PluginError(`Invalid plugin ${label}`)
}
function link(value: unknown, label: string): void {
  text(value, label, 2048)
  let url: URL
  try { url = new URL(value) } catch { throw new PluginError(`Invalid plugin ${label} URL`) }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new PluginError(`Plugin ${label} must be an HTTP(S) URL without credentials`)
}
export function validateIcon(value: unknown): void {
  text(value, 'icon', 350_000)
  if (/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return
  if (!/^[\w./-]+\.(?:png|jpe?g|webp|gif)$/i.test(value) || value.startsWith('/') || value.split('/').includes('..')) throw new PluginError('Plugin icons must be bundled PNG/JPEG/WebP/GIF files or base64 images')
}
export function validateDetails(m: PluginManifest): void {
  if (m.description !== undefined) text(m.description, 'description', 4000)
  if (m.author !== undefined) {
    if (!m.author || typeof m.author !== 'object' || Array.isArray(m.author)) throw new PluginError('Invalid plugin author')
    text(m.author.name, 'author name')
    if (m.author.url !== undefined) link(m.author.url, 'author')
  }
  for (const field of ['repository', 'homepage', 'documentation', 'issues', 'changelog'] as const) if (m[field] !== undefined) link(m[field], field)
  if (m.license !== undefined) text(m.license, 'license')
  if (m.keywords !== undefined) {
    if (!Array.isArray(m.keywords) || m.keywords.length > 20) throw new PluginError('Invalid plugin keywords')
    for (const keyword of m.keywords) text(keyword, 'keyword', 40)
  }
  if (m.icon !== undefined) validateIcon(m.icon)
}
