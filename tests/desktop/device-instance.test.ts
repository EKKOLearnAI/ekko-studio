import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deviceInstanceLaunch, prepareDeviceInstance } from '../../packages/desktop/src/main/device-instance'
describe('independent device process launch', () => {
  it('isolates state and does not inherit CLI mode, remote pin or port', () => {
    const parent = { ELECTRON_RUN_AS_NODE: '1', HERMES_DESKTOP_PORT: '8748', EKKO_STUDIO_DESKTOP_SERVER_URL: 'https://old.test' }
    const make = () => deviceInstanceLaunch({ home: '/state', userData: '/browser', serverUrl: 'https://new.test', devices: [], env: parent, argv: ['electron', '/app/main.js', '--quit'], packaged: false })
    const a = make(), b = make()
    expect(a.home).toBe(b.home)
    expect(a.userData).toBe(b.userData)
    expect(a.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(a.env.HERMES_DESKTOP_PORT).toBeUndefined()
    expect(a.env.EKKO_STUDIO_DESKTOP_SERVER_URL).toBe('https://new.test')
    expect(a.env.HERMES_HOME).toBe(join(a.home, 'hermes'))
    expect(a.args).toEqual(['/app/main.js'])
    expect(parent.HERMES_DESKTOP_PORT).toBe('8748')
  })
  it('persists only the child target and device catalog, no login tokens', () => {
    const root = mkdtempSync(join(tmpdir(), 'device-instance-'))
    try {
      const a = deviceInstanceLaunch({ home: root, userData: join(root, 'browser'), serverUrl: null, devices: [], env: {}, argv: [], packaged: true })
      prepareDeviceInstance(a)
      expect(JSON.parse(readFileSync(join(a.home, 'desktop-remote-server.json'), 'utf8'))).toEqual({ serverUrl: null, devices: [] })
      expect(a.args).toEqual([])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

it('strips sensitive parent environment without mutating it', () => {
  const env = { AUTH_TOKEN: 'test-only', OPENAI_API_KEY: 'test-only', PATH: '/bin' }
  const launch = deviceInstanceLaunch({ home: '/state', userData: '/browser', serverUrl: null, devices: [], env, argv: [], packaged: true })
  expect(launch.env.AUTH_TOKEN).toBeUndefined()
  expect(launch.env.OPENAI_API_KEY).toBeUndefined()
  expect(launch.env.PATH).toBe('/bin')
  expect(env.AUTH_TOKEN).toBe('test-only')
})
