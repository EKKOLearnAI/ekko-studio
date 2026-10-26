import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { load } from 'js-yaml'
import { windowsBuildArgs } from '../../packages/desktop/scripts/windows-build-args.mjs'
import { pythonBuildEnvironment, pythonDependencyBuildArgs } from '../../packages/desktop/scripts/python-build-env.mjs'

const read = (path: string) => readFileSync(path, 'utf8')
const workflow = (name: string) => load(read(`.github/workflows/${name}.yml`)) as any

describe('Windows ARM64 packaging', () => {
  it('selects separate update channels and defaults to the native Windows architecture', () => {
    expect(windowsBuildArgs(['--win', 'nsis', '--arm64'], 'darwin', 'arm64'))
      .toEqual(['--win', 'nsis', '--arm64', '--config.publish.channel=latest-arm64'])
    expect(windowsBuildArgs(['--win', 'nsis', '--x64'], 'win32', 'arm64'))
      .toEqual(['--win', 'nsis', '--x64'])
    expect(windowsBuildArgs([], 'win32', 'arm64')).toEqual(['--arm64', '--config.publish.channel=latest-arm64'])
    expect(windowsBuildArgs(['--mac', '--arm64'], 'darwin', 'arm64')).toEqual(['--mac', '--arm64'])
    expect(() => windowsBuildArgs(['--win', '--arm64', '--x64'])).toThrow('one architecture')
    expect(() => windowsBuildArgs(['--win', '--arm64', '--linux'])).toThrow('separately')
  })

  it('builds ARM64 installers on a native runner and uploads only their own manifest', () => {
    const release = workflow('desktop-release')
    const target = release.jobs.desktop.strategy.matrix.include.find((target: any) => target.target_os === 'win32' && target.target_arch === 'arm64')
    expect(target).toMatchObject({ runner: 'windows-11-arm', electron_target: '--win nsis --arm64' })
    expect(target.artifact_files.trim().split('\n')).toEqual([
      'packages/desktop/release/*-arm64.exe',
      'packages/desktop/release/*-arm64.exe.blockmap',
      'packages/desktop/release/latest-arm64.yml',
    ])
    const runtime = workflow('desktop-runtime').jobs.runtime.strategy.matrix.include
    expect(runtime.find((target: any) => target.target_os === 'win32' && target.target_arch === 'arm64'))
      .toMatchObject({ runner: 'windows-11-arm', skip_browser_runtime: true })
  })

  it('stages speech bindings after pruning in every Windows ARM64 packaging workflow', () => {
    for (const name of ['desktop-release', 'desktop-manual-build', 'desktop-update-test']) {
      const jobs = workflow(name).jobs
      const steps = (jobs.desktop || jobs.build).steps
      const prune = steps.findIndex((step: any) => step.run?.includes('npm prune'))
      const speech = steps.findIndex((step: any) => step.run?.includes('build-windows-arm64-speech.mjs'))
      const pack = steps.findIndex((step: any) => step.run?.includes('run dist'))
      expect(speech, name).toBeGreaterThan(prune)
      expect(pack, name).toBeGreaterThan(speech)
      expect(steps[speech].if).toContain('arm64')
    }
  })
})

describe('ARM64 Python dependency build environment', () => {
  it('hides the optional x64 MSYS winpty without removing native Git or changing the parent environment', () => {
    const env = { Path: '/git/cmd;/git/usr/bin;/system', OPENSSL_DIR: '/native/openssl' }
    const exists = (path: string) => path === '/git/usr/bin/winpty-agent.exe'
    expect(pythonBuildEnvironment(env, 'win32', 'arm64', exists)).toEqual({
      Path: '/git/cmd;/system', OPENSSL_DIR: '/native/openssl',
    })
    expect(pythonBuildEnvironment(env, 'win32', 'x64', exists)).toEqual(env)
    expect(env.Path).toBe('/git/cmd;/git/usr/bin;/system')
  })
})

it('enables ConPTY through pywinpty-specific build settings only on Windows ARM64', () => {
  expect(pythonDependencyBuildArgs('win32', 'arm64')).toEqual([
    '--config-settings-package', 'pywinpty:build-args=--features winpty-rs/conpty',
  ])
  expect(pythonDependencyBuildArgs('win32', 'x64')).toEqual([])
  expect(pythonDependencyBuildArgs('linux', 'arm64')).toEqual([])
})
