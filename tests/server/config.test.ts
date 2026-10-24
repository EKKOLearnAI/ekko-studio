import { describe, expect, it } from 'vitest'
import { homedir } from 'os'
import { join, resolve } from 'path'
import {
  getCorsOrigins,
  getLanAdvertiseUrl,
  getListenHost,
  getWebUiHome,
  isAppEntitlementRequired,
  isRemoteImagesAllowed,
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

  it('keeps remote images off unless HERMES_WEB_UI_ALLOW_REMOTE_IMAGES opts in', () => {
    expect(isRemoteImagesAllowed({})).toBe(false)
    expect(isRemoteImagesAllowed({ HERMES_WEB_UI_ALLOW_REMOTE_IMAGES: '' })).toBe(false)
    expect(isRemoteImagesAllowed({ HERMES_WEB_UI_ALLOW_REMOTE_IMAGES: '0' })).toBe(false)
    expect(isRemoteImagesAllowed({ HERMES_WEB_UI_ALLOW_REMOTE_IMAGES: 'false' })).toBe(false)
    expect(isRemoteImagesAllowed({ HERMES_WEB_UI_ALLOW_REMOTE_IMAGES: 'maybe' })).toBe(false)
    expect(isRemoteImagesAllowed({ HERMES_WEB_UI_ALLOW_REMOTE_IMAGES: '1' })).toBe(true)
    expect(isRemoteImagesAllowed({ HERMES_WEB_UI_ALLOW_REMOTE_IMAGES: ' TRUE ' })).toBe(true)
    expect(isRemoteImagesAllowed({ HERMES_WEB_UI_ALLOW_REMOTE_IMAGES: 'on' })).toBe(true)
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
