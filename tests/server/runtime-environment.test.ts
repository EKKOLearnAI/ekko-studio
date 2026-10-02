import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const originalContainer = process.env.container
const originalExplicitRoot = process.env.HERMES_WEB_UI_REPO_ROOT

let scratchRoot: string

function createRepo(
  root: string,
  options: { packageName?: string; withGitDir?: boolean; withPackageJson?: boolean } = {},
) {
  mkdirSync(root, { recursive: true })
  if (options.withGitDir !== false) mkdirSync(join(root, '.git'), { recursive: true })
  if (options.withPackageJson !== false) {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: options.packageName ?? 'ekko-studio', version: '0.0.0' }),
    )
  }
}

async function loadRuntimeEnvironment(
  options: { dockerEnvFile?: boolean; container?: string } = {},
) {
  vi.resetModules()
  if (options.container === undefined) delete process.env.container
  else process.env.container = options.container
  const existsSync = vi.fn((path: string) => path === '/.dockerenv' && options.dockerEnvFile === true)
  vi.doMock('fs', () => ({ existsSync }))
  const runtimeEnvironment = await import('../../packages/server/src/modules/studio/public/runtime-environment')
  return { ...runtimeEnvironment, existsSync }
}

/** Load the real module with real `fs`, isolating detection to an explicit root. */
async function loadWithExplicitRoot(root: string | undefined) {
  vi.resetModules()
  delete process.env.container
  if (root === undefined) delete process.env.HERMES_WEB_UI_REPO_ROOT
  else process.env.HERMES_WEB_UI_REPO_ROOT = root
  return import('../../packages/server/src/modules/studio/public/runtime-environment')
}

describe('runtime environment detection', () => {
  beforeEach(() => {
    scratchRoot = mkdtempSync(join(tmpdir(), 'ekko-runtime-env-'))
  })

  afterEach(() => {
    vi.doUnmock('fs')
    vi.resetModules()
    if (originalContainer === undefined) delete process.env.container
    else process.env.container = originalContainer
    if (originalExplicitRoot === undefined) delete process.env.HERMES_WEB_UI_REPO_ROOT
    else process.env.HERMES_WEB_UI_REPO_ROOT = originalExplicitRoot
    rmSync(scratchRoot, { recursive: true, force: true })
  })

  it('does not classify a regular Web UI process as Docker', async () => {
    const { isDockerContainer } = await loadRuntimeEnvironment()

    expect(isDockerContainer()).toBe(false)
  })

  it('detects the Docker environment marker file', async () => {
    const { isDockerContainer } = await loadRuntimeEnvironment({ dockerEnvFile: true })

    expect(isDockerContainer()).toBe(true)
  })

  it('detects the Docker container environment variable', async () => {
    const { isDockerContainer } = await loadRuntimeEnvironment({ container: 'docker' })

    expect(isDockerContainer()).toBe(true)
  })

  it('detects a git checkout deployment from the explicit repo root', async () => {
    const root = join(scratchRoot, 'repo')
    createRepo(root)

    const { getGitCloneRoot, isGitCloneDeployment } = await loadWithExplicitRoot(root)

    expect(getGitCloneRoot()).toBe(root)
    expect(isGitCloneDeployment()).toBe(true)
  })

  it('accepts the legacy `hermes-web-ui` package name', async () => {
    const root = join(scratchRoot, 'legacy')
    createRepo(root, { packageName: 'hermes-web-ui' })

    const { getGitCloneRoot } = await loadWithExplicitRoot(root)

    expect(getGitCloneRoot()).toBe(root)
  })

  it('does not treat a directory without .git as a checkout', async () => {
    const root = join(scratchRoot, 'no-git')
    createRepo(root, { withGitDir: false })

    const { getGitCloneRoot } = await loadWithExplicitRoot(root)

    // Ancestor probing may still resolve this checkout, but the directory lacking
    // `.git` must never be accepted as the root.
    expect(getGitCloneRoot()).not.toBe(root)
  })

  it('does not treat a foreign git repository as a checkout', async () => {
    const root = join(scratchRoot, 'foreign')
    createRepo(root, { packageName: 'some-other-tool' })

    const { getGitCloneRoot } = await loadWithExplicitRoot(root)

    expect(getGitCloneRoot()).not.toBe(root)
  })

  it('rejects a Docker environment even when a valid checkout is present', async () => {
    const root = join(scratchRoot, 'docker-repo')
    createRepo(root)
    if (originalContainer === undefined) delete process.env.container
    else process.env.container = originalContainer
    process.env.HERMES_WEB_UI_REPO_ROOT = root
    process.env.container = 'docker'
    vi.resetModules()

    const { isGitCloneDeployment } = await import('../../packages/server/src/modules/studio/public/runtime-environment')

    expect(isGitCloneDeployment()).toBe(false)
  })

  it('ignores a nonexistent explicit root and falls back to ancestor probing', async () => {
    const { getGitCloneRoot } = await loadWithExplicitRoot(join(scratchRoot, 'does-not-exist'))

    // The test process runs inside the Studio checkout, so ancestor probing resolves it.
    expect(getGitCloneRoot()).toBeTruthy()
  })
})
