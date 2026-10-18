import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'path'

afterEach(() => {
  vi.doUnmock('fs')
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function loadWithPackages(installedName: string, callerName: string) {
  vi.resetModules()
  const installedPath = resolve('package.json')
  const callerDir = resolve('unrelated-caller')
  const packages = new Map([
    [installedPath, { name: installedName, version: '1.0.0' }],
    [resolve(callerDir, 'package.json'), { name: callerName, version: '9.0.0' }],
  ])
  vi.doMock('fs', () => ({
    existsSync: (path: string) => packages.has(path),
    readFileSync: (path: string) => JSON.stringify(packages.get(path)),
  }))
  const { readStudioPackageInfo } = await import('../../packages/server/src/modules/studio/services/package-info')
  const { StudioHealthService } = await import('../../packages/server/src/modules/studio/services/health')
  vi.spyOn(process, 'cwd').mockReturnValue(callerDir)
  return { readStudioPackageInfo, StudioHealthService }
}

describe('installed Studio package identity', () => {
  it.each(['ekko-studio', 'hermes-web-ui'])('checks %s even when launched from the other package directory', async name => {
    const otherName = name === 'ekko-studio' ? 'hermes-web-ui' : 'ekko-studio'
    const { readStudioPackageInfo, StudioHealthService } = await loadWithPackages(name, otherName)
    expect(readStudioPackageInfo()).toMatchObject({ name, version: '1.0.0' })
    vi.stubEnv('HERMES_WEB_UI_DISABLE_UPDATE_CHECK', '')
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: '1.0.1' }) })
    vi.stubGlobal('fetch', fetchMock)
    await new StudioHealthService({} as any).checkLatestVersion()
    expect(fetchMock).toHaveBeenCalledWith(`https://registry.npmjs.org/${name}/latest`, expect.any(Object))
  })

  it('does not check the registry for an unrelated working-directory package', async () => {
    const { readStudioPackageInfo, StudioHealthService } = await loadWithPackages('unrelated', 'other-project')
    expect(readStudioPackageInfo()).toBeNull()
    vi.stubEnv('HERMES_WEB_UI_DISABLE_UPDATE_CHECK', '')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await new StudioHealthService({} as any).checkLatestVersion()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
