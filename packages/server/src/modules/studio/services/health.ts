import { readStudioPackageInfo } from './package-info'
import type { StudioHealthDependencies } from '../contracts/health'

declare const __APP_VERSION__: string

function isUpdateCheckDisabled(): boolean {
  const raw = (process.env.HERMES_WEB_UI_DISABLE_UPDATE_CHECK || '').trim().toLowerCase()
  return raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes'
}

function compareVersions(left: string, right: string): number {
  const normalize = (value: string) => value.trim().replace(/^v/i, '').split(/[.-]/)
  const leftParts = normalize(left)
  const rightParts = normalize(right)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index] || '0'
    const rightPart = rightParts[index] || '0'
    const leftNumber = Number.parseInt(leftPart, 10)
    const rightNumber = Number.parseInt(rightPart, 10)
    const numeric = Number.isFinite(leftNumber) && Number.isFinite(rightNumber)
    const diff = numeric
      ? leftNumber - rightNumber
      : leftPart.localeCompare(rightPart, undefined, { numeric: true })
    if (diff !== 0) return diff
  }
  return 0
}

function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0
}

export class StudioHealthService {
  private readonly packageInfo = readStudioPackageInfo()
  private readonly localVersion = typeof __APP_VERSION__ !== 'undefined'
    ? __APP_VERSION__
    : this.packageInfo?.version || ''
  private cachedLatestVersion = ''

  constructor(private readonly dependencies: StudioHealthDependencies) {}

  async checkLatestVersion(): Promise<void> {
    if (isUpdateCheckDisabled()) return
    try {
      const packageName = this.packageInfo?.name
      if (!packageName) return
      const registryName = encodeURIComponent(packageName)
      const response = await fetch(`https://registry.npmjs.org/${registryName}/latest`, {
        signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) return
      const data = await response.json() as { version: string }
      this.cachedLatestVersion = data.version
      if (this.localVersion
        && this.cachedLatestVersion
        && isNewerVersion(this.cachedLatestVersion, this.localVersion)) {
        console.log(`Update available: ${this.localVersion} → ${this.cachedLatestVersion}`)
      }
    } catch {
      // Version checks must not affect server health.
    }
  }

  startVersionCheck(): void {
    if (isUpdateCheckDisabled()) return
    setTimeout(() => this.checkLatestVersion(), 5000)
    setInterval(() => this.checkLatestVersion(), 30 * 60 * 1000)
  }

  async snapshot() {
    const rawVersion = await this.dependencies.getPrimaryAgentVersion()
    const primaryAgentVersion = rawVersion.split('\n')[0].replace('Hermes Agent ', '') || ''
    const agentBridge = await this.dependencies.getPrimaryAgentBridgeHealth()
    const updateCheckDisabled = isUpdateCheckDisabled()

    return {
      status: 'ok',
      platform: this.dependencies.platform,
      version: primaryAgentVersion,
      gateway: 'running',
      webui_version: this.localVersion,
      webui_latest: updateCheckDisabled ? '' : this.cachedLatestVersion,
      webui_update_available: updateCheckDisabled
        ? false
        : Boolean(
            this.localVersion
            && this.cachedLatestVersion
            && isNewerVersion(this.cachedLatestVersion, this.localVersion),
          ),
      node_version: process.versions.node,
      agent_bridge: agentBridge,
      is_docker: this.dependencies.isDockerContainer(),
    }
  }
}
