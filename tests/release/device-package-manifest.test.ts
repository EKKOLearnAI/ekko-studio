/**
 * Guards for the device-package manifest contract.
 *
 * The manifest published to OSS (`releases/<channel>/latest.json`) drives every
 * device-side update. The historical bug we are preventing:
 *
 *   - `manifest.packageType` and the device's `WEBUI_UPDATE_PACKAGE_TYPE`
 *     diverged, causing `manifest-client.ts` to throw `update_manifest_invalid`.
 *   - The device fell back to the npm registry path silently, then left
 *     stale `staging/` files behind, then refused the next update with
 *     `409 update_in_progress`.
 *
 * This test pins:
 *   - default `packageType` is `source-deploy` (matches the new device-side
 *     default in `scripts/deploy-source-armbian.sh`),
 *   - `source-deploy` manifests carry `sourceUrl` and `sourceSha256`,
 *   - `device-package` manifests carry `installerScriptSha256`,
 *   - `--strategy device-package` flips both the manifest field and the
 *     installer SHA,
 *   - the AGENTS.md hard rules describing this contract are present.
 */

import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve as resolvePath } from 'path'
import { list as listTar } from 'tar'
import { afterEach, describe, expect, it } from 'vitest'

const tempDirs: string[] = []

const PACKAGE_ALLOWLIST = [
  'dist/client',
  'dist/server',
  'hermes_data/bots/usb',
  'package.json',
  'package-lock.json',
  'release/device-host-dependencies.json',
  'scripts/deploy-source-armbian.sh',
  'scripts/hermes-web-ui-update-runner.sh',
  'scripts/hermes-web-ui-update.service',
  'scripts/hermes-web-ui.service',
  'scripts/install-device-package.sh',
  'scripts/update-source-deploy.sh',
  'scripts/update-orchestrator.sh',
  'scripts/recover-interrupted-update.sh',
  'scripts/journal-validator.sh',
]

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

interface FixtureOptions {
  packageType?: 'source-deploy' | 'device-package'
  withSource?: boolean
}

function seedRepo(prefix: string, options: FixtureOptions = {}) {
  const repoRoot = createTempDir(prefix)
  const outputDir = createTempDir(`${prefix}-out-`)

  mkdirSync(resolvePath(repoRoot, 'dist', 'server'), { recursive: true })
  mkdirSync(resolvePath(repoRoot, 'dist', 'client'), { recursive: true })
  mkdirSync(resolvePath(repoRoot, 'hermes_data', 'bots', 'usb'), { recursive: true })
  mkdirSync(resolvePath(repoRoot, 'release'), { recursive: true })
  mkdirSync(resolvePath(repoRoot, 'scripts'), { recursive: true })
  mkdirSync(resolvePath(repoRoot, 'packages'), { recursive: true })
  mkdirSync(resolvePath(repoRoot, 'plugins', 'builtin'), { recursive: true })
  writeFileSync(resolvePath(repoRoot, 'plugins', 'builtin', 'packages.json'), '{}\n')
  mkdirSync(resolvePath(repoRoot, 'docs'), { recursive: true })
  mkdirSync(resolvePath(repoRoot, '.github'), { recursive: true })
  writeFileSync(resolvePath(repoRoot, 'packages', 'README.md'), '# packages placeholder\n', 'utf-8')
  writeFileSync(resolvePath(repoRoot, 'docs', 'openapi.json'), '{ "openapi": "3.0.0" }\n', 'utf-8')

  writeFileSync(
    resolvePath(repoRoot, 'dist', 'server', 'index.js'),
    'console.log("/api/hermes/terminal"); console.log("node-pty failed to load, terminal feature disabled"); console.log("WebSocket ready at /terminal")\n',
    'utf-8',
  )
  writeFileSync(resolvePath(repoRoot, 'dist', 'client', 'index.html'), '<html></html>\n', 'utf-8')
  writeFileSync(resolvePath(repoRoot, 'scripts', 'deploy-source-armbian.sh'), '#!/usr/bin/env bash\n', 'utf-8')
  chmodSync(resolvePath(repoRoot, 'scripts', 'deploy-source-armbian.sh'), 0o755)
  writeFileSync(resolvePath(repoRoot, 'scripts', 'hermes-web-ui-update-runner.sh'), '#!/usr/bin/env bash\n', 'utf-8')
  chmodSync(resolvePath(repoRoot, 'scripts', 'hermes-web-ui-update-runner.sh'), 0o755)
  writeFileSync(resolvePath(repoRoot, 'scripts', 'hermes-web-ui-update.service'), '[Service]\nExecStart=/usr/local/sbin/hermes-web-ui-update-runner\n', 'utf-8')
  writeFileSync(resolvePath(repoRoot, 'scripts', 'hermes-web-ui.service'), '[Service]\nExecStart=node dist/server/index.js\n', 'utf-8')
  writeFileSync(resolvePath(repoRoot, 'scripts', 'install-device-package.sh'), '#!/usr/bin/env bash\n', 'utf-8')
  chmodSync(resolvePath(repoRoot, 'scripts', 'install-device-package.sh'), 0o755)
  writeFileSync(resolvePath(repoRoot, 'scripts', 'update-source-deploy.sh'), '#!/usr/bin/env bash\n', 'utf-8')
  chmodSync(resolvePath(repoRoot, 'scripts', 'update-source-deploy.sh'), 0o755)
  // Phase (a) scripts: the orchestrator is the update-path installer whose
  // SHA the manifest pins; the others ship with the packageAllowlist.
  writeFileSync(resolvePath(repoRoot, 'scripts', 'update-orchestrator.sh'), '#!/usr/bin/env bash\n', 'utf-8')
  chmodSync(resolvePath(repoRoot, 'scripts', 'update-orchestrator.sh'), 0o755)
  writeFileSync(resolvePath(repoRoot, 'scripts', 'recover-interrupted-update.sh'), '#!/usr/bin/env bash\n', 'utf-8')
  chmodSync(resolvePath(repoRoot, 'scripts', 'recover-interrupted-update.sh'), 0o755)
  writeFileSync(resolvePath(repoRoot, 'scripts', 'journal-validator.sh'), '#!/usr/bin/env bash\n', 'utf-8')
  chmodSync(resolvePath(repoRoot, 'scripts', 'journal-validator.sh'), 0o755)
  writeFileSync(resolvePath(repoRoot, 'hermes_data', 'bots', 'usb', 'config.py'), 'WEBUI_HOME = "/tmp/hermes"\n', 'utf-8')
  writeFileSync(resolvePath(repoRoot, 'hermes_data', 'bots', 'usb', 'usb_monitor.py'), 'print("usb monitor")\n', 'utf-8')
  writeFileSync(resolvePath(repoRoot, 'release', 'device-host-dependencies.json'), JSON.stringify({
    schema: 1,
    aptPackages: ['python3-pyudev', 'ntfs-3g'],
  }, null, 2), 'utf-8')
  writeFileSync(resolvePath(repoRoot, 'package-lock.json'), '{ "name": "@quanthermes/hermes-web-ui", "lockfileVersion": 3 }\n', 'utf-8')
  writeFileSync(resolvePath(repoRoot, 'package.json'), JSON.stringify({
    name: '@quanthermes/hermes-web-ui',
    version: '1.2.3',
    repository: {
      type: 'git',
      url: 'https://github.com/example/hermes-web-ui.git',
    },
    engines: { node: '>=23.0.0' },
  }, null, 2), 'utf-8')
  writeFileSync(resolvePath(repoRoot, 'tsconfig.json'), '{}\n', 'utf-8')
  writeFileSync(resolvePath(repoRoot, 'tsconfig.app.json'), '{}\n', 'utf-8')
  writeFileSync(resolvePath(repoRoot, 'tsconfig.node.json'), '{}\n', 'utf-8')
  writeFileSync(resolvePath(repoRoot, 'vite.config.ts'), 'export default {}\n', 'utf-8')
  writeFileSync(resolvePath(repoRoot, '.github', 'device-package-release.json'), JSON.stringify({
    version: '1.2.3',
    channel: 'stable',
    minCurrentVersion: '1.0.0',
    manifestBranch: 'release-manifests',
    hostDependenciesPath: 'release/device-host-dependencies.json',
    ossPublicBaseUrl: 'https://example-bucket.oss-cn-shanghai.aliyuncs.com',
    ossPath: 'hermes-web-ui',
    packageAllowlist: PACKAGE_ALLOWLIST,
    sourceRepoUrl: 'https://github.com/tangledup-ai/hermes-web-ui',
    sourcePathAllowlist: [
      'package.json',
      'packages',
      'plugins',
      'hermes_data/bots/usb',
      'scripts',
      'docs',
      'tsconfig.json',
      'tsconfig.app.json',
      'tsconfig.node.json',
      'vite.config.ts',
      '.github/device-package-release.json',
    ],
  }, null, 2), 'utf-8')

  return { repoRoot, outputDir }
}

async function buildAndReadManifest(options: FixtureOptions) {
  const { buildDevicePackageRelease } = await import('../../scripts/build-device-package.mjs')
  const { repoRoot, outputDir } = seedRepo(`manifest-${options.packageType ?? 'default'}-`, options)
  const result = await buildDevicePackageRelease({
    repoRoot,
    outputDir,
    channel: 'stable',
    releaseRepo: 'example/hermes-web-ui',
    tag: 'v1.2.3',
    packageType: options.packageType,
  })
  return {
    repoRoot,
    outputDir,
    manifest: JSON.parse(readFileSync(result.manifestPath, 'utf-8')),
    latest: JSON.parse(readFileSync(result.latestPath, 'utf-8')),
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('device-package manifest contract', () => {
  it('defaults packageType to source-deploy', async () => {
    const { manifest } = await buildAndReadManifest({})
    expect(manifest.packageType).toBe('source-deploy')
  })

  it('source-deploy manifest carries sourceUrl and sourceSha256', async () => {
    const { manifest } = await buildAndReadManifest({})
    expect(manifest.packageType).toBe('source-deploy')
    expect(manifest.sourceUrl).toMatch(/^https?:\/\//)
    expect(manifest.sourceSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.sourceUrls.length).toBeGreaterThanOrEqual(1)
  })

  it('source-deploy: sourceUrl points to device-package tar (pre-built dist/) not pure source', async () => {
    // The orchestrator auto-detects pre-built dist/ to skip on-device
    // builds. For this to work, sourceUrl must resolve to the device-package
    // tar (which CI builds with dist/), not the pure-source tar.
    const { manifest } = await buildAndReadManifest({})
    expect(manifest.packageType).toBe('source-deploy')
    // sourceUrl should reference the device-package artifact name
    // (hermes-web-ui-device-<tag>.tar.gz), not the source artifact
    // (hermes-web-ui-source-<tag>.tar.gz).
    expect(manifest.sourceUrl).toMatch(/hermes-web-ui-device-/)
    expect(manifest.sourceUrl).not.toMatch(/hermes-web-ui-source-/)
    // sourceSha256 should match packageSha256 (same device-package tar)
    expect(manifest.sourceSha256).toBe(manifest.sha256)
  })

  it('source-deploy manifest pins the phase (a) orchestrator as installer', async () => {
    const { manifest } = await buildAndReadManifest({})
    expect(manifest.installerScriptPath).toBe('scripts/update-orchestrator.sh')
    expect(manifest.installerScriptSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('source-deploy manifest lists OSS as primary sourceUrls, GitHub as fallback', async () => {
    // Per update-fleet-spec § R2: domestic devices reach the artifact via
    // OSS first; GitHub release assets follow as the mirror. Mirror order
    // is a pure availability optimisation, sha256 verifies whichever
    // succeeds.
    const { manifest } = await buildAndReadManifest({})
    expect(manifest.packageType).toBe('source-deploy')
    const urls = manifest.sourceUrls
    expect(urls.length).toBeGreaterThanOrEqual(2)
    expect(urls[0]).toMatch(/oss-cn-shanghai\.aliyuncs\.com/)
    // GitHub release asset must follow, not precede, the OSS URL.
    const githubIdx = urls.findIndex(u => u.includes('github.com'))
    expect(githubIdx).toBeGreaterThan(0)
    // The first entry is what the orchestrator fetches first.
    expect(manifest.sourceUrl).toBe(urls[0])
  })

  it('source-deploy manifest emits the identity block (distSha256 + versionString)', async () => {
    const { manifest } = await buildAndReadManifest({})
    expect(manifest.identity).toBeDefined()
    expect(manifest.identity.versionString).toBe('1.2.3')
    expect(manifest.identity.distSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('build fails when staged package.json version does not match the release version (v0.7.0-customer class)', async () => {
    const { buildDevicePackageRelease } = await import('../../scripts/build-device-package.mjs')
    const { repoRoot, outputDir } = seedRepo('manifest-mismatch-')
    // Align the release config with the requested version so the config
    // consistency check passes and the dist-identity self-check is the gate
    // that fires (v0.7.0-customer class).
    const configPath = resolvePath(repoRoot, '.github', 'device-package-release.json')
    writeFileSync(configPath, JSON.stringify({ ...JSON.parse(readFileSync(configPath, 'utf-8')), version: '9.9.9' }), 'utf-8')
    let message = ''
    try {
      await buildDevicePackageRelease({
        repoRoot,
        outputDir,
        channel: 'stable',
        releaseRepo: 'example/hermes-web-ui',
        tag: 'v1.2.3',
        version: '9.9.9', // manifest would claim 9.9.9 over a 1.2.3 dist
        packageType: 'source-deploy',
      })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('manifest self-check')
    expect(message).toContain('does not match release version 9.9.9')
  })

  it('source archive is wrapped in a single top-level dir (update-source-deploy.sh contract)', async () => {
    // Regression guard for the 6.6.6.31 v0.8.0 failure: devices unpack the
    // source artifact and resolve the repo root via
    // `find -mindepth 1 -maxdepth 1 -type d | head -n 1`, then require
    // `package.json` and `scripts/deploy-source-armbian.sh` under it. A flat
    // archive makes that resolution pick `.github/` or `packages/` and die with
    // "Downloaded archive is not a valid hermes-web-ui source tree".
    const { buildDevicePackageRelease } = await import('../../scripts/build-device-package.mjs')
    const { repoRoot, outputDir } = seedRepo('manifest-source-layout-')
    const result = await buildDevicePackageRelease({
      repoRoot,
      outputDir,
      channel: 'stable',
      releaseRepo: 'example/hermes-web-ui',
      tag: 'v1.2.3',
    })
    const meta = JSON.parse(readFileSync(result.metadataPath, 'utf-8'))
    expect(meta.sourceArtifactPath).toBeTruthy()

    const entries = new Set<string>()
    await listTar({
      file: meta.sourceArtifactPath,
      onentry: (e) => entries.add(e.path.replace(/^\.\//, '').replace(/\/+$/, '')),
    })
    const topLevelDirs = [...entries]
      .filter(p => !p.includes('/'))
      .filter(p => p !== '' && p !== '.')
    expect(topLevelDirs).toEqual(['hermes-web-ui-1.2.3'])
    expect(entries.has('hermes-web-ui-1.2.3/package.json')).toBe(true)
    expect(entries.has('hermes-web-ui-1.2.3/scripts/deploy-source-armbian.sh')).toBe(true)
  })

  it('source archive carries every root file the device build needs', async () => {
    // Regression guard for the 6.6.6.31 v0.8.0 failure: after the wrapper-dir
    // fix let the archive unpack, the device `npm run build` still died with
    // `Error: ENOENT ... docs/openapi.json` and `error TS5083: Cannot read
    // file 'tsconfig.app.json'` because those root entries were missing from
    // `sourcePathAllowlist`. Build on the device runs from the source root, so
    // the archive must ship docs/, tsconfig.app/node, and vite.config.ts.
    const { buildDevicePackageRelease } = await import('../../scripts/build-device-package.mjs')
    const { repoRoot, outputDir } = seedRepo('manifest-source-buildfiles-')
    const result = await buildDevicePackageRelease({
      repoRoot,
      outputDir,
      channel: 'stable',
      releaseRepo: 'example/hermes-web-ui',
      tag: 'v1.2.3',
    })
    const meta = JSON.parse(readFileSync(result.metadataPath, 'utf-8'))

    const entries = new Set<string>()
    await listTar({
      file: meta.sourceArtifactPath,
      onentry: (e) => entries.add(e.path.replace(/^\.\//, '').replace(/\/+$/, '')),
    })
    for (const required of [
      'hermes-web-ui-1.2.3/docs/openapi.json',
      'hermes-web-ui-1.2.3/plugins/builtin/packages.json',
      'hermes-web-ui-1.2.3/hermes_data/bots/usb/usb_monitor.py',
      'hermes-web-ui-1.2.3/tsconfig.app.json',
      'hermes-web-ui-1.2.3/tsconfig.node.json',
      'hermes-web-ui-1.2.3/vite.config.ts',
    ]) {
      expect(entries.has(required), `source archive must contain ${required}`).toBe(true)
    }
  })

  it('device-package manifest emits installerScriptPath + installerScriptSha256', async () => {
    const { manifest } = await buildAndReadManifest({ packageType: 'device-package' })
    expect(manifest.packageType).toBe('device-package')
    expect(manifest.installerScriptPath).toBe('scripts/install-device-package.sh')
    expect(manifest.installerScriptSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects unknown packageType values', async () => {
    await expect(buildAndReadManifest({ packageType: 'npm-package' as unknown as 'source-deploy' })).rejects.toThrow(
      /packageType must be one of/,
    )
  })

  it('manifest and latest.json are byte-identical', async () => {
    const { manifest, latest } = await buildAndReadManifest({})
    expect(manifest).toEqual(latest)
  })
})

describe('AGENTS.md enforces the contract', () => {
  const agentsPath = resolvePath(__dirname, '..', '..', 'AGENTS.md')

  it('declares source-deploy as the default strategy', () => {
    const text = readFileSync(agentsPath, 'utf-8')
    expect(text).toMatch(/WEBUI_UPDATE_STRATEGY.*default.*source-deploy/s)
  })

  it('pins the manifest packageType ↔ device packageType matching rule', () => {
    const text = readFileSync(agentsPath, 'utf-8')
    expect(text).toMatch(/manifest.*packageType.*WEBUI_UPDATE_PACKAGE_TYPE.*must match/s)
  })

  it('requires sourceUrl and sourceSha256 for source-deploy', () => {
    const text = readFileSync(agentsPath, 'utf-8')
    expect(text).toMatch(/source-deploy manifest requires sourceUrl\/sourceSha256/is)
  })
})