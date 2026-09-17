import { beforeEach, describe, expect, it, vi } from 'vitest'
import { join, resolve } from 'node:path'

const mocks = vi.hoisted(() => ({ exec: vi.fn(), read: vi.fn(), pack: vi.fn() }))
vi.mock('node:child_process', () => ({ execFileSync: mocks.exec }))
vi.mock('node:fs', () => ({ readFileSync: mocks.read }))
vi.mock('../../scripts/pack-npm-releases.mjs', () => ({ packNpmReleases: mocks.pack }))

import { parsePublishOptions, publishNpmReleases } from '../../scripts/publish-npm-releases.mjs'

const root = resolve('fixture repo with spaces')
const npmCli = resolve('fixture node/npm-cli.js')
const packages = ['ekko-studio', 'hermes-web-ui'].map(name => ({ name, version: '1.0.0', filename: `${name}-1.0.0.tgz` }))

beforeEach(() => {
  vi.resetAllMocks()
  mocks.read.mockReturnValue(JSON.stringify({ name: 'ekko-studio', version: '1.0.0' }))
  mocks.pack.mockReturnValue(packages)
})

describe('local dual npm publishing', () => {
  it('builds once and publishes both verified tarballs with argument arrays', () => {
    publishNpmReleases(root, parsePublishOptions([]), npmCli)
    expect(mocks.exec).toHaveBeenNthCalledWith(1, process.execPath, [npmCli, 'run', 'build'], { cwd: root, stdio: 'inherit' })
    expect(mocks.pack).toHaveBeenCalledWith(root, join(root, 'release/npm'), npmCli)
    for (const [index, pkg] of packages.entries()) {
      expect(mocks.exec).toHaveBeenNthCalledWith(index + 2, process.execPath,
        [npmCli, 'publish', join(root, 'release/npm', pkg.filename), '--access', 'public', '--tag', 'latest',
          '--ignore-scripts', '--registry', 'https://registry.npmjs.org'], { cwd: root, stdio: 'inherit' })
    }
  })

  it('builds and packs in dry-run mode without executing npm publish', () => {
    publishNpmReleases(root, parsePublishOptions(['--dry-run']), npmCli)
    expect(mocks.exec).toHaveBeenCalledTimes(1)
    expect(mocks.pack).toHaveBeenCalledOnce()
  })

  it('retries only the selected package', () => {
    publishNpmReleases(root, parsePublishOptions(['--package', 'hermes-web-ui']), npmCli)
    expect(mocks.exec).toHaveBeenCalledTimes(2)
    expect(mocks.exec.mock.calls[1][1]).toContain(join(root, 'release/npm/hermes-web-ui-1.0.0.tgz'))
  })

  it('defaults prereleases to next and accepts an explicit dist-tag', () => {
    mocks.read.mockReturnValue(JSON.stringify({ name: 'ekko-studio', version: '1.0.0-beta.1' }))
    publishNpmReleases(root, parsePublishOptions([]), npmCli)
    expect(mocks.exec.mock.calls[1][1]).toContain('next')
    mocks.exec.mockClear()
    publishNpmReleases(root, parsePublishOptions(['--tag', 'beta']), npmCli)
    expect(mocks.exec.mock.calls[1][1]).toContain('beta')
  })

  it('does not pack or publish when the build fails', () => {
    mocks.exec.mockImplementationOnce(() => { throw new Error('build failed') })
    expect(() => publishNpmReleases(root, parsePublishOptions([]), npmCli)).toThrow('build failed')
    expect(mocks.pack).not.toHaveBeenCalled()
    expect(mocks.exec).toHaveBeenCalledTimes(1)
  })

  it('stops on publish failure and identifies all remaining packages', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.exec.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error('publish failed') })
    try {
      expect(() => publishNpmReleases(root, parsePublishOptions([]), npmCli)).toThrow('publish failed')
      expect(mocks.exec).toHaveBeenCalledTimes(2)
      expect(log).toHaveBeenCalledWith('npm run publish:npm -- --package ekko-studio --tag latest')
      expect(log).toHaveBeenCalledWith('npm run publish:npm -- --package hermes-web-ui --tag latest')
    } finally { log.mockRestore() }
  })

  it.each([['--unknown'], ['--package'], ['--package', 'other-package'], ['--tag'], ['--tag', '--dry-run']])('rejects invalid options %j', (...args) => {
    expect(() => parsePublishOptions(args)).toThrow()
    expect(mocks.exec).not.toHaveBeenCalled()
  })
})
