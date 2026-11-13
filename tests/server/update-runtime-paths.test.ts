import { describe, expect, it } from 'vitest'
import { join, resolve } from 'path'
import { homedir } from 'os'
import { resolveUpdateRuntimePaths } from '../../packages/server/src/modules/studio/services/update/runtime-paths'

describe('update runtime paths', () => {
  it('resolves default runtime paths from cwd and default app home', () => {
    const paths = resolveUpdateRuntimePaths({}, '/opt/hermes-web-ui')

    expect(paths.deployDir).toBe(resolve('/opt/hermes-web-ui'))
    expect(paths.webUiHome).toBe(join(homedir(), '.hermes-web-ui'))
    expect(paths.uploadDir).toBe(join(homedir(), '.hermes-web-ui', 'upload'))
    expect(paths.hermesHome).toBe('')
  })

  it('resolves configured web-ui, upload, hermes, and deploy paths', () => {
    const paths = resolveUpdateRuntimePaths({
      DEPLOY_DIR: './deploy-root',
      HERMES_WEB_UI_HOME: './state/web-ui',
      UPLOAD_DIR: './state/uploads',
      HERMES_HOME_DIR: './state/hermes',
    }, '/tmp/current')

    expect(paths.deployDir).toBe(resolve('./deploy-root'))
    expect(paths.webUiHome).toBe(resolve('./state/web-ui'))
    expect(paths.uploadDir).toBe(resolve('./state/uploads'))
    expect(paths.hermesHome).toBe(resolve('./state/hermes'))
  })
})
