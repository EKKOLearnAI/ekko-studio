import { config, hasConfiguredManifestCheck, hasConfiguredUpdateCheck, hasConfiguredUpdateExecution } from '../public/config'
import type { StudioHealthDependencies } from '../contracts/health'
import { getSnapshot, refresh as refreshUpdateCheck } from './update/update-check-cache'
import { getLastEnvironmentCheck } from './update/reconcile'
import { getLocalWebUiVersion } from './update/package-info'
import { isRemoteVersionNewer } from './update/version-compare'

declare const __APP_VERSION__: string

function isUpdateCheckDisabled(): boolean {
  if (hasConfiguredUpdateCheck(config.update)) return false
  const raw = (process.env.HERMES_WEB_UI_DISABLE_UPDATE_CHECK || '').trim().toLowerCase()
  return ['true', '1', 'on', 'yes'].includes(raw)
}

export class StudioHealthService {
  private readonly localVersion = getLocalWebUiVersion(
    typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '',
  )

  constructor(private readonly dependencies: StudioHealthDependencies) {}

  async checkLatestVersion(): Promise<void> {
    if (isUpdateCheckDisabled() || !hasConfiguredManifestCheck(config.update)) return
    const { result } = await refreshUpdateCheck(true)
    if (result?.latestVersion && isRemoteVersionNewer(this.localVersion, result.latestVersion)) {
      console.log(`Update available: ${this.localVersion} → ${result.latestVersion}`)
    }
  }

  startVersionCheck(): void {
    if (!hasConfiguredUpdateCheck(config.update) || isUpdateCheckDisabled()) return
    setTimeout(() => this.checkLatestVersion(), 5000).unref()
    setInterval(() => this.checkLatestVersion(), 5 * 60 * 1000).unref()
  }

  async snapshot() {
    const rawVersion = await this.dependencies.getPrimaryAgentVersion()
    const primaryAgentVersion = rawVersion.split('\n')[0].replace('Hermes Agent ', '') || ''
    const agentBridge = await this.dependencies.getPrimaryAgentBridgeHealth()
    const disabled = isUpdateCheckDisabled()
    const configured = hasConfiguredUpdateCheck(config.update)
    const { result } = getSnapshot()
    return {
      status: 'ok',
      platform: this.dependencies.platform,
      version: primaryAgentVersion,
      gateway: 'running',
      webui_version: this.localVersion,
      webui_latest: disabled ? '' : result?.latestVersion || '',
      webui_update_enabled: hasConfiguredUpdateExecution(config.update),
      webui_update_source_label: configured ? result?.sourceLabel || config.update.sourceLabel : '',
      webui_update_channel: configured ? result?.channel || config.update.channel : '',
      webui_update_strategy: configured ? config.update.strategy : '',
      webui_update_package_type: configured ? result?.packageType || config.update.packageType : '',
      webui_update_available: !disabled && isRemoteVersionNewer(this.localVersion, result?.latestVersion || ''),
      webui_update_warnings: disabled ? [] : result?.warnings || [],
      webui_update_pinned_manifest_url: disabled ? '' : result?.pinnedManifestUrl || '',
      webui_update_effective_manifest_url: disabled ? '' : result?.effectiveManifestUrl || '',
      node_version: process.versions.node,
      agent_bridge: agentBridge,
      is_docker: this.dependencies.isDockerContainer(),
      environment: getLastEnvironmentCheck(),
    }
  }
}
