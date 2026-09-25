const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { mkdtemp, mkdir, readFile, writeFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { load: loadYaml } = require('js-yaml')
const desktopRoot = resolve(__dirname, '..')
const baseEnv = {
  DESKTOP_UPDATE_TEST_TARGET: 'darwin-arm64',
  DESKTOP_UPDATE_TEST_VERSION: '0.7.900',
  DESKTOP_UPDATE_TEST_URL: 'https://updates.example.com/mac-arm64/',
}
const script = () => import('../scripts/build-update-test.mjs')

test('real electron-builder loads isolated config without modifying release identity or metadata on disk', async t => {
  const { createTestBuildConfig } = await script()
  const { config } = createTestBuildConfig(baseEnv)
  const folder = await mkdtemp(join(tmpdir(), 'ekko-test-builder-config-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const path = join(folder, 'config.json')
  await writeFile(path, JSON.stringify(config))
  const { Packager } = require('app-builder-lib/out/packager')
  const packager = new Packager({ projectDir: desktopRoot, config: path, publish: 'never' })
  await packager.validateConfig()
  const effective = packager.config
  const release = loadYaml(await readFile(join(desktopRoot, 'electron-builder.yml'), 'utf8'))
  assert.equal(effective.appId, release.appId)
  assert.equal(effective.productName, release.productName)
  assert.equal(effective.afterPack, release.afterPack)
  assert.equal(effective.mac.hardenedRuntime, true)
  assert.equal(effective.mac.forceCodeSigning, true)
  assert.equal(effective.mac.notarize, true)
  assert.equal(effective.mac.entitlements, release.mac.entitlements)
  assert.equal(effective.nsis.include, release.nsis.include)
  assert.deepEqual(effective.publish, [{ provider: 'generic', url: baseEnv.DESKTOP_UPDATE_TEST_URL, channel: 'latest' }])
  assert.equal(packager.metadata.version, '0.7.900')
  assert.equal(packager.metadata.desktopUpdate.url, baseEnv.DESKTOP_UPDATE_TEST_URL)
  const original = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'))
  assert.equal(original.desktopUpdate, undefined)
  assert.notEqual(original.version, '0.7.900')
})

test('test build rejects missing feed/version, ambiguous versions and unsupported targets', async () => {
  const { createTestBuildConfig } = await script()
  for (const patch of [
    { DESKTOP_UPDATE_TEST_URL: '' },
    { DESKTOP_UPDATE_TEST_URL: 'https://download.ekkolearnai.com/latest' },
    ...['', 'v1.0.0', '1.0.1-beta.1', '1.0.0+test', '01.0.0', '1.0.999999'].map(DESKTOP_UPDATE_TEST_VERSION => ({ DESKTOP_UPDATE_TEST_VERSION })),
    { DESKTOP_UPDATE_TEST_TARGET: 'win32-arm64' }, { DESKTOP_UPDATE_TEST_TARGET: 'constructor' },
  ]) assert.throws(() => createTestBuildConfig({ ...baseEnv, ...patch }))
})

test('test CLI permits validation but rejects publishing/config overrides before invoking the builder', () => {
  const path = join(desktopRoot, 'scripts/build-update-test.mjs')
  const env = { ...process.env, ...baseEnv }
  const valid = spawnSync(process.execPath, [path, '--validate'], { env, encoding: 'utf8' })
  assert.equal(valid.status, 0, valid.stderr)
  assert.equal(JSON.parse(valid.stdout).updateSource.url, baseEnv.DESKTOP_UPDATE_TEST_URL)
  for (const args of [['--publish', 'always'], ['--config.mac.notarize=false']]) {
    const result = spawnSync(process.execPath, [path, ...args], { env, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /cannot override/)
  }
})

test('required mac signing refuses missing secrets before touching the keychain or GITHUB_ENV', async () => {
  const { requireMacNotarization } = await script()
  assert.throws(() => requireMacNotarization({}), /APPLE_ID/)
  const env = { ...process.env }
  for (const key of ['GITHUB_ENV', 'RUNNER_TEMP', 'MAC_CSC_LINK', 'MAC_APPLE_ID', 'MAC_APPLE_APP_SPECIFIC_PASSWORD', 'MAC_APPLE_TEAM_ID']) delete env[key]
  const result = spawnSync(process.execPath, [join(desktopRoot, 'scripts/configure-macos-signing.mjs'), '--require-signed'], { env, encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /signing and notarization secrets/)
  assert.doesNotMatch(result.stdout, /unsigned/)
})

async function artifactsFixture(t, target = 'darwin-arm64') {
  const output = await mkdtemp(join(tmpdir(), 'ekko-test-artifacts-'))
  t.after(() => rm(output, { recursive: true, force: true }))
  const { createTestBuildConfig } = await script()
  const { config } = createTestBuildConfig({ ...baseEnv, DESKTOP_UPDATE_TEST_TARGET: target })
  const metadata = config.extraMetadata
  const mac = target.startsWith('darwin')
  const linux = target.startsWith('linux')
  const manifestName = linux ? (target.endsWith('arm64') ? 'latest-linux-arm64.yml' : 'latest-linux.yml') : mac ? 'latest-mac.yml' : 'latest.yml'
  const resources = join(output, mac ? `${target.endsWith('arm64') ? 'mac-arm64' : 'mac'}/Ekko Studio.app/Contents/Resources`
    : linux ? `${target.endsWith('arm64') ? 'linux-arm64-unpacked' : 'linux-unpacked'}/resources` : 'win-unpacked/resources')
  const source = join(output, 'package-source')
  await mkdir(source)
  await mkdir(resources, { recursive: true })
  const { createPackage, uncache } = await import('@electron/asar')
  const writePackage = async value => {
    await writeFile(join(source, 'package.json'), JSON.stringify(value))
    await createPackage(source, join(resources, 'app.asar'))
    uncache(join(resources, 'app.asar'))
  }
  await writePackage(metadata)
  const feedPath = join(resources, 'app-update.yml')
  await writeFile(feedPath, JSON.stringify(config.publish[0]))
  const files = []
  for (const extension of (mac ? ['zip', 'dmg'] : linux ? ['AppImage'] : ['exe'])) {
    const name = `Ekko.Studio-${metadata.version}-${target.split('-')[1]}.${extension}`
    const bytes = Buffer.from(`fixture:${name}`)
    await writeFile(join(output, name), bytes)
    if (linux) {
      const { appendBlockmap } = require('app-builder-lib/out/targets/differentialUpdateInfoBuilder')
      files.push({ url: name, ...await appendBlockmap(join(output, name)) })
    } else {
      await writeFile(join(output, `${name}.blockmap`), 'fixture blockmap')
      files.push({ url: name, sha512: createHash('sha512').update(bytes).digest('base64'), size: bytes.length })
    }
  }
  const manifest = { version: metadata.version, files, path: files[0].url, sha512: files[0].sha512 }
  const manifestPath = join(output, manifestName)
  await writeFile(manifestPath, JSON.stringify(manifest))
  return { output, metadata, manifest, manifestPath, manifestName, feedPath, writePackage }
}

test('artifact verification accepts real ASAR packages and complete manifests for every supported target', async t => {
  const { verifyTestArtifacts } = await script()
  for (const target of ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64', 'linux-arm64']) {
    const fixture = await artifactsFixture(t, target)
    const files = await verifyTestArtifacts(fixture.output, target, fixture.metadata)
    assert(files.includes(fixture.manifestName))
    assert.equal(files.includes(`${fixture.manifest.path}.blockmap`), !target.startsWith('linux'))
  }
})

test('Linux feed verifies builder-generated embedded blockmaps and rejects broken metadata/footer', async t => {
  const { verifyTestFeed } = await script()
  for (const target of ['linux-x64', 'linux-arm64']) {
    const { output, metadata, manifest, manifestPath, manifestName } = await artifactsFixture(t, target)
    assert.deepEqual(await verifyTestFeed(output, target, metadata), [manifestName, manifest.path])
    const size = manifest.files[0].blockMapSize
    delete manifest.files[0].blockMapSize
    await writeFile(manifestPath, JSON.stringify(manifest))
    await assert.rejects(verifyTestFeed(output, target, metadata), /blockmap size/)
    manifest.files[0].blockMapSize = size
    const file = join(output, manifest.path)
    const bytes = await readFile(file)
    bytes.writeUInt32BE(size + 1, bytes.length - 4)
    await writeFile(file, bytes)
    manifest.sha512 = manifest.files[0].sha512 = createHash('sha512').update(bytes).digest('base64')
    await writeFile(manifestPath, JSON.stringify(manifest))
    await assert.rejects(verifyTestFeed(output, target, metadata), /blockmap footer/)
  }
})

test('artifact verification rejects a production source inside either packaged update configuration', async t => {
  const { verifyTestArtifacts } = await script()
  const fixture = await artifactsFixture(t)
  await writeFile(fixture.feedPath, JSON.stringify({ provider: 'generic', url: 'https://download.ekkolearnai.com/latest' }))
  await assert.rejects(verifyTestArtifacts(fixture.output, 'darwin-arm64', fixture.metadata), /app-update.yml/)
  await fixture.writePackage({ version: fixture.metadata.version })
  await assert.rejects(verifyTestArtifacts(fixture.output, 'darwin-arm64', fixture.metadata), /Packaged version or update source/)
})

test('artifact verification rejects corrupt bytes, missing blockmaps and incomplete mac manifests', async t => {
  const { verifyTestArtifacts } = await script()
  const fixture = await artifactsFixture(t)
  const { output, manifest, manifestPath, metadata } = fixture
  const file = join(output, manifest.path)
  const original = await readFile(file)
  await writeFile(file, Buffer.alloc(original.length))
  await assert.rejects(verifyTestArtifacts(output, 'darwin-arm64', metadata), /checksum or size/)
  await writeFile(file, original)
  await rm(`${file}.blockmap`)
  await assert.rejects(verifyTestArtifacts(output, 'darwin-arm64', metadata), /ENOENT/)
  await writeFile(`${file}.blockmap`, 'fixture blockmap')
  await writeFile(manifestPath, JSON.stringify({ ...manifest, files: manifest.files.filter(entry => entry.url.endsWith('.dmg')) }))
  await assert.rejects(verifyTestArtifacts(output, 'darwin-arm64', metadata), /missing required/)
})

test('test workflow isolates cross-repo credentials and requires signing on macOS', async () => {
  const workflow = loadYaml(await readFile(join(desktopRoot, '../../.github/workflows/desktop-update-test.yml'), 'utf8'))
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.equal(workflow.on.workflow_dispatch.inputs.release_tag, undefined)
  assert.equal(workflow.on.workflow_dispatch.inputs.update_feed_url, undefined)
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.target.options,
    ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64', 'linux-arm64'])
  assert(workflow.jobs.build['runs-on'].includes('"linux-x64":"ubuntu-22.04"'))
  assert(workflow.jobs.build['runs-on'].includes('"linux-arm64":"ubuntu-22.04-arm"'))
  assert.equal(workflow.concurrency.group, 'desktop-update-test-${{ inputs.target }}')
  assert.equal(workflow.concurrency['cancel-in-progress'], false)
  assert.equal(workflow.jobs.build.env.DESKTOP_UPDATE_TEST_URL,
    'https://github.com/EKKOLearnAI/ekko-studio-update-test/releases/download/update-test-${{ inputs.target }}/')
  assert.equal(workflow.jobs.build.env.GH_TOKEN, undefined)
  const steps = workflow.jobs.build.steps
  assert(steps.some(step => step.run?.includes('configure-macos-signing.mjs --require-signed')))
  assert(steps.some(step => step.run?.includes('run dist:update-test')))
  assert(steps.some(step => step.uses === 'actions/upload-artifact@v4'))
  const publishers = steps.filter(step => step.env?.GH_TOKEN)
  assert.equal(publishers.length, 2)
  for (const step of publishers) {
    assert.equal(step.env.GH_TOKEN, '${{ secrets.DESKTOP_UPDATE_TEST_TOKEN }}')
    assert(step.run.includes('scripts/publish-update-test.mjs'))
  }
  assert(steps.at(-1).run.endsWith('scripts/publish-update-test.mjs'))
  assert(!steps.some(step => /action-gh-release|gh release/.test(`${step.uses ?? ''} ${step.run ?? ''}`)))
})

test('release workflow supports old tags without updater tests but propagates actual test failures', async t => {
  const workflow = loadYaml(await readFile(join(desktopRoot, '../../.github/workflows/desktop-release.yml'), 'utf8'))
  const step = workflow.jobs.desktop.steps.find(step => step.name === 'Verify desktop updater download lifecycle')
  const args = step.run.trim().split(/\s+/).slice(1)
  const folder = await mkdtemp(join(tmpdir(), 'ekko-old-release-tag-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  args[args.indexOf('--prefix') + 1] = folder
  assert(process.env.npm_execpath, 'Run this suite through npm run test:updater')
  const run = () => spawnSync(process.execPath, [process.env.npm_execpath, ...args], { cwd: folder, encoding: 'utf8' })
  await writeFile(join(folder, 'package.json'), JSON.stringify({ name: 'old-release', version: '1.0.0', scripts: {} }))
  const oldTag = run()
  assert.equal(oldTag.status, 0, oldTag.stderr)
  await writeFile(join(folder, 'package.json'), JSON.stringify({ name: 'new-release', version: '1.1.0', scripts: { 'test:updater': 'node lifecycle.cjs' } }))
  await writeFile(join(folder, 'lifecycle.cjs'), "require('node:fs').writeFileSync('ran', 'yes')")
  const newTag = run()
  assert.equal(newTag.status, 0, newTag.stderr)
  assert.equal(await readFile(join(folder, 'ran'), 'utf8'), 'yes')
  await writeFile(join(folder, 'lifecycle.cjs'), 'process.exit(7)')
  assert.equal(run().status, 7, 'A failing updater test must still block release packaging')
})
