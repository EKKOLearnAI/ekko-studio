import { describe, expect, it, vi } from 'vitest'
import { homedir } from 'os'
import { join, resolve } from 'path'
import {
  getCorsOrigins,
  getDeployDir,
  getHermesHome,
  getLanAdvertiseUrl,
  getListenHost,
  getUploadDir,
  getWebUiHome,
  hasConfiguredManifestCheck,
  hasConfiguredUpdateCheck,
  isAppEntitlementRequired,
  sanitizeConfigValue,
  shouldCreateWebUiDataDir,
} from '../../packages/server/src/modules/studio/public/config'

describe('server config', () => {
  it('defaults to an IPv4 bind host', () => {
    expect(getListenHost({})).toBe('0.0.0.0')
  })

  it('uses BIND_HOST when provided', () => {
    expect(getListenHost({ BIND_HOST: ' :: ' })).toBe('::')
  })

  it('ignores blank BIND_HOST values', () => {
    expect(getListenHost({ BIND_HOST: ' ' })).toBe('0.0.0.0')
  })

  it('defaults web-ui home to ~/.hermes-web-ui', () => {
    expect(getWebUiHome({})).toBe(join(homedir(), '.hermes-web-ui'))
  })

  it('uses HERMES_WEB_UI_HOME when provided', () => {
    expect(getWebUiHome({ HERMES_WEB_UI_HOME: ' ./tmp/hermes-ui ' })).toBe(resolve('./tmp/hermes-ui'))
  })

  it('uses HERMES_WEBUI_STATE_DIR as a compatibility alias', () => {
    expect(getWebUiHome({ HERMES_WEBUI_STATE_DIR: ' ./tmp/hermes-state ' })).toBe(resolve('./tmp/hermes-state'))
  })

  it('defaults upload dir under the web-ui home', () => {
    expect(getUploadDir({})).toBe(join(homedir(), '.hermes-web-ui', 'upload'))
  })

  it('uses UPLOAD_DIR when provided', () => {
    expect(getUploadDir({ UPLOAD_DIR: ' ./tmp/uploads ' })).toBe(resolve('./tmp/uploads'))
  })

  it('prefers HERMES_HOME and falls back to HERMES_HOME_DIR', () => {
    expect(getHermesHome({ HERMES_HOME: ' ./tmp/hermes-home ' })).toBe(resolve('./tmp/hermes-home'))
    expect(getHermesHome({ HERMES_HOME_DIR: ' ./tmp/hermes-home-dir ' })).toBe(resolve('./tmp/hermes-home-dir'))
  })

  it('uses DEPLOY_DIR when provided and falls back to cwd', () => {
    expect(getDeployDir({ DEPLOY_DIR: ' ./tmp/deploy ' }, 'g:/ignored')).toBe(resolve('./tmp/deploy'))
    expect(getDeployDir({}, '/tmp/current')).toBe(resolve('/tmp/current'))
  })

  it('treats manifest configuration as a valid update check source', () => {
    expect(hasConfiguredManifestCheck({
      enabled: true,
      strategy: 'device-package',
      packageName: '',
      registry: '',
      sourceLabel: 'Manifest',
      distTag: 'latest',
      cliBin: '',
      script: '',
      runnerService: 'hermes-web-ui-update.service',
      runnerRequestFile: '/home/hermesui/.hermes-web-ui/updates/update-runner-request.json',
      channel: 'stable',
      manifestUrl: 'https://updates.example.com/stable/manifest.json',
      manifestBaseUrl: '',
      packageType: 'device-package',
    })).toBe(true)
    expect(hasConfiguredUpdateCheck({
      enabled: true,
      strategy: 'device-package',
      packageName: '',
      registry: '',
      sourceLabel: 'Manifest',
      distTag: 'latest',
      cliBin: '',
      script: '',
      runnerService: 'hermes-web-ui-update.service',
      runnerRequestFile: '/home/hermesui/.hermes-web-ui/updates/update-runner-request.json',
      channel: 'stable',
      manifestUrl: '',
      manifestBaseUrl: 'https://updates.example.com',
      packageType: 'device-package',
    })).toBe(true)
  })

  it('only creates the development data directory outside production', () => {
    expect(shouldCreateWebUiDataDir({ NODE_ENV: 'development' })).toBe(true)
    expect(shouldCreateWebUiDataDir({ NODE_ENV: 'production' })).toBe(false)
  })

  it('does not enable cross-origin requests by default', () => {
    expect(getCorsOrigins({})).toBe('')
  })

  it('uses CORS_ORIGINS when provided', () => {
    expect(getCorsOrigins({ CORS_ORIGINS: ' https://app.example, http://localhost:3000 ' })).toBe('https://app.example, http://localhost:3000')
  })

  it('strips accidental quoting markers from configured URLs', () => {
    expect(sanitizeConfigValue(' `https://updates.example.com/releases` ')).toBe('https://updates.example.com/releases')
    expect(sanitizeConfigValue('"https://registry.npmjs.org"')).toBe('https://registry.npmjs.org')
    expect(sanitizeConfigValue("'https://github.com/tangledup-ai/hermes-web-ui'")).toBe('https://github.com/tangledup-ai/hermes-web-ui')
  })

  it('normalizes the Docker LAN advertise origin', () => {
    expect(getLanAdvertiseUrl({ HERMES_LAN_ADVERTISE_URL: ' 192.168.10.102:6060/path ' })).toBe('http://192.168.10.102:6060')
    expect(getLanAdvertiseUrl({ HERMES_LAN_ADVERTISE_URL: 'file:///tmp/studio' })).toBe('')
  })

  it('enforces App entitlements by default and allows an explicit compatibility opt-out', () => {
    expect(isAppEntitlementRequired({})).toBe(true)
    expect(isAppEntitlementRequired({ HERMES_APP_ENTITLEMENT_REQUIRED: 'true' })).toBe(true)
    expect(isAppEntitlementRequired({ HERMES_APP_ENTITLEMENT_REQUIRED: 'off' })).toBe(false)
  })
})


describe('independent update defaults', () => {
  it('keeps Hermes Agent upgrades opt-in', async () => {
    vi.resetModules()
    vi.stubEnv('WEBUI_UPDATE_INCLUDE_AGENT_UPGRADE', undefined)
    try {
      const { config } = await import('../../packages/server/src/modules/studio/public/config')
      expect(config.update.includeAgentUpgrade).toBe(false)
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })
})
