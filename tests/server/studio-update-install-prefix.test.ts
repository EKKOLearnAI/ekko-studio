import { describe, expect, it } from 'vitest'
import { resolveGlobalInstallPrefix } from '../../packages/server/src/modules/studio/services/update/install-target'

describe('resolveGlobalInstallPrefix', () => {
  it('returns the prefix of a POSIX global install under /usr/local', () => {
    expect(resolveGlobalInstallPrefix('/usr/local/lib/node_modules/ekko-studio', 'linux')).toBe('/usr/local')
  })

  it('returns /usr for a global install owned by the distro node package', () => {
    expect(resolveGlobalInstallPrefix('/usr/lib/node_modules/ekko-studio', 'linux')).toBe('/usr')
  })

  it('returns versioned prefixes such as nvm and homebrew', () => {
    expect(
      resolveGlobalInstallPrefix('/root/.nvm/versions/node/v24.22.1/lib/node_modules/ekko-studio', 'linux'),
    ).toBe('/root/.nvm/versions/node/v24.22.1')
    expect(
      resolveGlobalInstallPrefix('/opt/homebrew/lib/node_modules/ekko-studio', 'darwin'),
    ).toBe('/opt/homebrew')
  })

  it('returns the Windows global prefix', () => {
    expect(
      resolveGlobalInstallPrefix('C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\ekko-studio', 'win32'),
    ).toBe('C:\\Users\\me\\AppData\\Roaming\\npm')
  })

  it('ignores project-local dependencies and source checkouts', () => {
    expect(resolveGlobalInstallPrefix('/srv/app/node_modules/ekko-studio', 'linux')).toBeNull()
    expect(resolveGlobalInstallPrefix('/home/me/ekko-studio', 'linux')).toBeNull()
    expect(resolveGlobalInstallPrefix('D:\\repos\\ekko-studio', 'win32')).toBeNull()
  })
})
