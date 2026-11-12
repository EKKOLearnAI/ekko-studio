import type { InstalledPlugin } from '@/api/studio/plugins'
import { normalizePluginRepository, type PluginRelease } from '@/api/studio/plugin-releases'

const exactVersion = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?$/
export function comparePluginVersions(left: string, right: string): number | null {
  const a = exactVersion.exec(left), b = exactVersion.exec(right)
  if (!a || !b || left.length > 128 || right.length > 128) return null
  for (let i = 1; i <= 3; i++) {
    const difference = BigInt(a[i]) - BigInt(b[i])
    if (difference) return difference > 0n ? 1 : -1
  }
  if (a[4] === b[4]) return 0
  if (!a[4] || !b[4]) return a[4] ? -1 : 1
  const ap = a[4].split('.'), bp = b[4].split('.')
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    if (ap[i] === bp[i]) continue
    if (ap[i] === undefined || bp[i] === undefined) return ap[i] === undefined ? -1 : 1
    const an = /^\d+$/.test(ap[i]), bn = /^\d+$/.test(bp[i])
    if (an && bn) {
      const difference = BigInt(ap[i]) - BigInt(bp[i])
      if (difference) return difference > 0n ? 1 : -1
    } else return an !== bn ? (an ? -1 : 1) : ap[i] > bp[i] ? 1 : -1
  }
  return 0
}
export function pluginRepository(plugin: InstalledPlugin): string | null {
  const github = /^github:([\w.-]+\/[\w.-]+)#[a-f0-9]{40}$/.exec(plugin.source)
  if (github) return normalizePluginRepository(`https://github.com/${github[1]}`)
  const git = /^git\+(https:\/\/[^#]+)#[a-f0-9]{40}$/.exec(plugin.source)
  if (git) return normalizePluginRepository(git[1])
  return normalizePluginRepository(plugin.manifest.repository)
}
export function installedPluginRepository(plugin: InstalledPlugin): string | null {
  return pluginInstallationKind(plugin) === 'package' ? pluginRepository(plugin) : null
}
export function pluginInstallationKind(plugin: InstalledPlugin): 'development' | 'local' | 'package' {
  if (plugin.developmentDirectory) return 'development'
  // Unlinking stops watching but retains the local snapshot and its original source.
  return /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(plugin.source) ? 'local' : 'package'
}
export function samePluginInstallation(left: InstalledPlugin | undefined, right: InstalledPlugin | undefined): boolean {
  return !left || !right ? left === right : left.manifest.id === right.manifest.id && left.manifest.version === right.manifest.version
    && left.source === right.source && left.developmentDirectory === right.developmentDirectory && left.installedAt === right.installedAt
}
export type PublishedPluginAction = 'install' | 'switch' | 'upgrade' | 'reinstall'
export function publishedPluginAction(plugin: InstalledPlugin | undefined, release?: PluginRelease | null): PublishedPluginAction | undefined {
  if (!release) return
  if (!plugin) return 'install'
  if (pluginRepository(plugin) !== release.repository || plugin.manifest.id !== release.manifestId || plugin.manifest.apiVersion !== release.apiVersion) return
  if (pluginInstallationKind(plugin) !== 'package') return 'switch'
  const compared = comparePluginVersions(release.version, plugin.manifest.version)
  if (compared === 1) return 'upgrade'
  if (compared === 0 && plugin.status === 'failed') return 'reinstall'
}
export function availablePluginUpdate(plugin: InstalledPlugin, release?: PluginRelease): PluginRelease | undefined {
  if (!release || installedPluginRepository(plugin) !== release.repository || plugin.manifest.id !== release.manifestId
    || plugin.manifest.apiVersion !== release.apiVersion || comparePluginVersions(release.version, plugin.manifest.version) !== 1) return
  return release
}

export type PluginUpdateState = 'available' | 'current' | 'ahead' | 'local' | 'unknown' | 'checking' | 'development' | 'manual'
export function pluginUpdateState(plugin: InstalledPlugin, release?: PluginRelease | null, checking = false, failed = false): PluginUpdateState {
  if (plugin.developmentDirectory) return 'development'
  if (!pluginRepository(plugin)) return 'manual'
  if (pluginInstallationKind(plugin) === 'local') return release?.repository === pluginRepository(plugin)
    && release.manifestId === plugin.manifest.id && release.apiVersion === plugin.manifest.apiVersion
    && comparePluginVersions(release.version, plugin.manifest.version) === -1 ? 'ahead' : 'local'
  if (availablePluginUpdate(plugin, release || undefined)) return 'available'
  if (checking) return 'checking'
  if (failed || !release || release.repository !== pluginRepository(plugin) || release.manifestId !== plugin.manifest.id
    || release.apiVersion !== plugin.manifest.apiVersion || comparePluginVersions(release.version, plugin.manifest.version) === null) return 'unknown'
  return comparePluginVersions(release.version, plugin.manifest.version) === -1 ? 'ahead' : 'current'
}
