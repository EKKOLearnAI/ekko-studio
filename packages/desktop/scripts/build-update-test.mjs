#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'

const require = createRequire(import.meta.url)
const { validateTestUpdateUrl, resolveDesktopUpdateSource } = require('../dist/main/updater-source.js')
const { load: loadYaml } = require('js-yaml')
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const targets = {
  'darwin-arm64': { platform: 'darwin', args: ['--mac', 'dmg', 'zip', '--arm64'], resources: 'mac-arm64/Ekko Studio.app/Contents/Resources', manifest: 'latest-mac.yml' },
  'darwin-x64': { platform: 'darwin', args: ['--mac', 'dmg', 'zip', '--x64'], resources: 'mac/Ekko Studio.app/Contents/Resources', manifest: 'latest-mac.yml' },
  'win32-x64': { platform: 'win32', args: ['--win', 'nsis', '--x64'], resources: 'win-unpacked/resources', manifest: 'latest.yml' },
  'linux-x64': { platform: 'linux', args: ['--linux', 'AppImage', '--x64'], resources: 'linux-unpacked/resources', manifest: 'latest-linux.yml' },
  'linux-arm64': { platform: 'linux', args: ['--linux', 'AppImage', '--arm64'], resources: 'linux-arm64-unpacked/resources', manifest: 'latest-linux-arm64.yml' },
}

export function createTestBuildConfig(env) {
  const url = validateTestUpdateUrl(env.DESKTOP_UPDATE_TEST_URL)
  const version = env.DESKTOP_UPDATE_TEST_VERSION?.trim()
  if (!version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
    || version.split('.').some(part => Number(part) > 65535)) {
    throw new Error('DESKTOP_UPDATE_TEST_VERSION must be a numeric X.Y.Z version (each part <= 65535)')
  }
  const target = env.DESKTOP_UPDATE_TEST_TARGET
  if (!Object.hasOwn(targets, target ?? '')) {
    throw new Error(`DESKTOP_UPDATE_TEST_TARGET must be one of: ${Object.keys(targets).join(', ')}`)
  }
  return {
    target,
    config: {
      extends: join(desktopRoot, 'electron-builder.yml'),
      extraMetadata: { version, desktopUpdate: { channel: 'test', url } },
      publish: [{ provider: 'generic', url, channel: 'latest' }],
      detectUpdateChannel: false,
      generateUpdatesFilesForAllChannels: false,
      directories: { output: join(desktopRoot, 'release-update-test', target, version) },
      ...(targets[target].platform === 'darwin' ? { mac: { forceCodeSigning: true, notarize: true } } : {}),
    },
  }
}

export function requireMacNotarization(env) {
  const missing = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'].filter(key => !env[key]?.trim())
  if (missing.length) throw new Error(`Signed update testing requires notarization credentials: ${missing.join(', ')}`)
}

async function sha512(path) {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('base64')
}

async function verifyAppImageBlockmap(file, entry) {
  const size = entry.blockMapSize
  if (!Number.isSafeInteger(size) || size <= 0 || size > 16 * 1024 * 1024 || size + 4 >= entry.size) {
    throw new Error('Missing or invalid embedded AppImage blockmap size')
  }
  const handle = await open(file, 'r')
  try {
    const footer = Buffer.alloc(4)
    const dataSize = entry.size - size - 4
    const compressed = Buffer.alloc(size)
    if ((await handle.read(footer, 0, 4, entry.size - 4)).bytesRead !== 4 || footer.readUInt32BE(0) !== size
      || (await handle.read(compressed, 0, size, dataSize)).bytesRead !== size) {
      throw new Error('Embedded AppImage blockmap footer differs from the manifest')
    }
    const map = JSON.parse(inflateRawSync(compressed, { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8'))
    const data = map.files?.[0]
    if (map.version !== '2' || !Array.isArray(map.files) || map.files.length !== 1 || data?.offset !== 0
      || !Array.isArray(data.sizes) || !data.sizes.length || !Array.isArray(data.checksums)
      || data.checksums.length !== data.sizes.length || data.checksums.some(value => typeof value !== 'string' || !value)
      || data.sizes.some(value => !Number.isSafeInteger(value) || value <= 0)
      || data.sizes.reduce((sum, value) => sum + value, 0) !== dataSize) {
      throw new Error('Invalid embedded AppImage blockmap contents')
    }
  } finally { await handle.close() }
}

export async function verifyTestArtifacts(output, target, metadata) {
  const info = targets[target]
  if (!info) throw new Error('Unknown test artifact target')
  const expectedSource = resolveDesktopUpdateSource(metadata)
  if (expectedSource.channel !== 'test') throw new Error('Test artifact metadata must select the test feed')
  const resources = join(output, info.resources)
  const { extractFile } = await import('@electron/asar')
  const packaged = JSON.parse(extractFile(join(resources, 'app.asar'), 'package.json').toString('utf8'))
  const source = resolveDesktopUpdateSource(packaged)
  if (packaged.version !== metadata.version || source.channel !== 'test' || source.url !== expectedSource.url) {
    throw new Error('Packaged version or update source differs from the requested test build')
  }
  const nativeFeed = loadYaml(await readFile(join(resources, 'app-update.yml'), 'utf8'))
  if (nativeFeed?.provider !== 'generic' || nativeFeed.url !== expectedSource.url || nativeFeed.channel !== 'latest') {
    throw new Error('Packaged app-update.yml must also point exclusively at the test feed')
  }
  return verifyTestFeed(output, target, metadata)
}

export async function verifyTestFeed(output, target, metadata) {
  const info = targets[target]
  if (!info) throw new Error('Unknown test artifact target')
  const manifest = loadYaml(await readFile(join(output, info.manifest), 'utf8'))
  if (manifest?.version !== metadata.version || !Array.isArray(manifest.files) || !manifest.files.length) {
    throw new Error('Missing or mismatched test update manifest')
  }
  const names = []
  for (const entry of manifest.files) {
    const name = entry.url
    if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
      throw new Error('Test manifests must reference local artifact filenames')
    }
    const file = join(output, name)
    if ((await stat(file)).size !== entry.size || await sha512(file) !== entry.sha512) {
      throw new Error(`Test artifact checksum or size mismatch: ${name}`)
    }
    names.push(name)
    if (info.platform === 'linux') {
      if (!name.endsWith('.AppImage')) throw new Error('Linux update tests require AppImage artifacts')
      await verifyAppImageBlockmap(file, entry)
    } else {
      const blockmap = `${name}.blockmap`
      if ((await stat(join(output, blockmap))).size === 0) throw new Error(`Empty blockmap: ${blockmap}`)
      names.push(blockmap)
    }
  }
  const required = info.platform === 'darwin' ? ['.zip', '.dmg'] : info.platform === 'linux' ? ['.AppImage'] : ['.exe']
  if (required.some(extension => !names.some(name => name.endsWith(extension)))) {
    throw new Error('Test feed is missing required installers or update archives')
  }
  if (!names.includes(manifest.path) || !manifest.files.some(entry => entry.url === manifest.path && entry.sha512 === manifest.sha512)) {
    throw new Error('Legacy manifest path/checksum must refer to a verified test artifact')
  }
  return [info.manifest, ...new Set(names)]
}

async function main() {
  if (process.argv.slice(2).some(arg => arg !== '--validate')) {
    throw new Error('Only --validate is accepted; test builds cannot override publishing or signing options')
  }
  const { target, config } = createTestBuildConfig(process.env)
  if (process.argv.includes('--validate')) {
    console.log(JSON.stringify({ target, version: config.extraMetadata.version, updateSource: config.extraMetadata.desktopUpdate }, null, 2))
    return
  }
  const info = targets[target]
  if (process.platform !== info.platform) throw new Error('Build update-test installers on their target OS')
  if (info.platform === 'darwin') requireMacNotarization(process.env)
  const output = config.directories.output
  const previous = await readdir(output).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  if (previous.length) throw new Error(`Use a fresh version or move the previous test output: ${output}`)
  const temporary = await mkdtemp(join(tmpdir(), 'ekko-update-test-config-'))
  try {
    const configFile = join(temporary, 'electron-builder.json')
    await writeFile(configFile, JSON.stringify(config))
    const result = spawnSync(process.execPath, [require.resolve('electron-builder/cli'),
      '--config', configFile, ...info.args, '--publish', 'never'], { cwd: desktopRoot, stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`Test desktop build failed (exit ${result.status ?? result.signal})`)
    const artifacts = await verifyTestArtifacts(output, target, config.extraMetadata)
    const feed = join(output, 'feed')
    await mkdir(feed)
    for (const name of artifacts) await copyFile(join(output, name), join(feed, name))
    await writeFile(join(feed, 'update-test-build.json'), JSON.stringify({
      target, version: config.extraMetadata.version, source: config.extraMetadata.desktopUpdate,
      manifest: info.manifest, artifacts,
    }, null, 2) + '\n')
    console.log(`Verified test update feed files: ${feed}`)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
