#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestBuildConfig, verifyTestFeed } from './build-update-test.mjs'

const { load: loadYaml } = createRequire(import.meta.url)('js-yaml')
// Deliberately not configurable: this token and publisher must never target production releases.
export const TEST_REPOSITORY = 'EKKOLearnAI/ekko-studio-update-test'
const apiRoot = `repos/${TEST_REPOSITORY}`

export function publishConfig(env) {
  const url = `https://github.com/${TEST_REPOSITORY}/releases/download/update-test-${env.DESKTOP_UPDATE_TEST_TARGET}/`
  if (env.DESKTOP_UPDATE_TEST_URL && env.DESKTOP_UPDATE_TEST_URL !== url) {
    throw new Error('GitHub test publishing requires the fixed per-target test feed URL')
  }
  const { target, config } = createTestBuildConfig({ ...env, DESKTOP_UPDATE_TEST_URL: url })
  return { target, version: config.extraMetadata.version, metadata: config.extraMetadata,
    tag: `update-test-${target}`, url, feed: join(config.directories.output, 'feed') }
}

function runGh(args, input) {
  const result = spawnSync('gh', args, { input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' } })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `gh failed: ${result.status ?? result.signal}`)
  }
  return result.stdout
}

export function githubClient(run = runGh) {
  const api = (path, method = 'GET', body) => JSON.parse(run(
    ['api', `${apiRoot}/${path}`, '--method', method, ...(body ? ['--input', '-'] : [])],
    body ? JSON.stringify(body) : undefined,
  ) || 'null')
  return {
    repository: () => JSON.parse(run(['api', apiRoot])),
    // The by-tag endpoint excludes drafts. Listing authenticated releases also
    // finds a draft left by a failed first upload, so retry does not create a duplicate.
    release: tag => JSON.parse(run(['api', `${apiRoot}/releases?per_page=100`, '--paginate', '--slurp']))
      .flat().find(release => release.tag_name === tag) ?? null,
    create: tag => api('releases', 'POST', { tag_name: tag, name: `Desktop update test: ${tag.replace('update-test-', '')}`,
      body: 'Isolated Ekko Studio update testing. Test installers only. See the repository README for A → B instructions.',
      draft: true, prerelease: true, make_latest: 'false' }),
    assets: id => JSON.parse(run(['api', `${apiRoot}/releases/${id}/assets?per_page=100`, '--paginate', '--slurp'])).flat(),
    download: id => run(['api', `${apiRoot}/releases/assets/${id}`, '-H', 'Accept: application/octet-stream']),
    upload: (tag, path) => run(['release', 'upload', tag, path, '--repo', `github.com/${TEST_REPOSITORY}`]),
    rename: (id, name) => api(`releases/assets/${id}`, 'PATCH', { name }),
    publish: id => api(`releases/${id}`, 'PATCH', { draft: false, prerelease: true, make_latest: 'false' }),
  }
}

export function checkRepository(client, env = process.env) {
  if (env.GITHUB_ACTIONS === 'true' && !env.GH_TOKEN?.trim()) {
    throw new Error(`Set Actions secret DESKTOP_UPDATE_TEST_TOKEN: a fine-grained token with Contents read/write for ${TEST_REPOSITORY} only`)
  }
  const repo = client.repository()
  if (repo.full_name !== TEST_REPOSITORY || repo.private || repo.archived || repo.disabled) {
    throw new Error('Test publishing requires the expected active public test repository')
  }
}

function compareVersions(a, b) {
  if (![a, b].every(value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))) {
    throw new Error('Invalid version in test feed')
  }
  const left = a.split('.').map(Number), right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i]
  return 0
}

async function fingerprint(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return { size: (await stat(path)).size, digest: `sha256:${hash.digest('hex')}` }
}

function matches(asset, expected) {
  return asset?.state === 'uploaded' && asset.size === expected.size && asset.digest === expected.digest
}

export async function publishFeed(config, client = githubClient()) {
  const { feed, metadata, target, tag, version, url } = config
  const names = await verifyTestFeed(feed, target, metadata)
  const [manifestName, ...artifacts] = names
  // Only files listed in the verified manifest are uploaded, never a directory glob.
  const summary = JSON.parse(await readFile(join(feed, 'update-test-build.json'), 'utf8'))
  if (summary.target !== target || summary.version !== version || summary.source?.channel !== 'test'
    || summary.source.url !== url || summary.manifest !== manifestName
    || JSON.stringify(summary.artifacts) !== JSON.stringify(names)) {
    throw new Error('Test build summary differs from the requested GitHub feed')
  }
  if (artifacts.some(name => !name.includes(`-${version}-`) && !name.includes(`-${version}.`))) {
    throw new Error('Test installers and blockmaps must have versioned filenames')
  }
  const manifestText = await readFile(join(feed, manifestName), 'utf8')
  let release = client.release(tag)
  if (release && (release.tag_name !== tag || !release.prerelease || release.immutable)) {
    throw new Error('Existing test release must be a mutable prerelease with the expected tag')
  }
  let assets = release ? client.assets(release.id) : []
  let current = assets.find(asset => asset.name === manifestName)
  if (!current) {
    // A runner can be terminated between the two rename requests. Recover the most
    // recent backup before comparing versions, including on the next workflow run.
    const backup = assets.filter(asset => asset.name === `previous-${asset.id}-${manifestName}`)
      .sort((a, b) => b.id - a.id)[0]
    if (backup) current = client.rename(backup.id, manifestName)
  }
  if (current) {
    const remoteText = client.download(current.id)
    const comparison = compareVersions(version, loadYaml(remoteText)?.version)
    if (comparison < 0) throw new Error('Refusing to replace a newer test feed with an older version')
    if (comparison === 0 && remoteText !== manifestText) {
      throw new Error('This test version is already published with different content; use a higher version')
    }
  }
  const fingerprints = new Map()
  for (const name of artifacts) {
    const expected = await fingerprint(join(feed, name))
    fingerprints.set(name, expected)
    const existing = assets.find(asset => asset.name === name)
    if (existing && !matches(existing, expected)) {
      throw new Error(`Refusing to overwrite an existing test asset: ${name}; use a higher version`)
    }
  }
  if (!release) release = client.create(tag)
  for (const name of artifacts) {
    if (!assets.some(asset => asset.name === name)) client.upload(tag, join(feed, name))
  }
  assets = client.assets(release.id)
  for (const [name, expected] of fingerprints) {
    if (!matches(assets.find(asset => asset.name === name), expected)) {
      throw new Error(`Uploaded test asset failed GitHub size/SHA-256 verification: ${name}`)
    }
  }
  const expectedManifest = await fingerprint(join(feed, manifestName))
  if (!matches(current, expectedManifest)) {
    const temporary = await mkdtemp(join(tmpdir(), 'ekko-test-publish-'))
    try {
      const stagedName = `next-${version}-${manifestName}`
      const stagedPath = join(temporary, stagedName)
      await copyFile(join(feed, manifestName), stagedPath)
      let staged = assets.find(asset => asset.name === stagedName)
      if (!staged) {
        client.upload(tag, stagedPath)
        staged = client.assets(release.id).find(asset => asset.name === stagedName)
      }
      if (!matches(staged, expectedManifest)) throw new Error('Staged test manifest failed GitHub checksum verification')
      // GitHub has no atomic asset replacement. Keep the old manifest as a recoverable
      // backup and restore its name if switching fails; never delete it with --clobber.
      if (current) client.rename(current.id, `previous-${current.id}-${manifestName}`)
      try {
        client.rename(staged.id, manifestName)
      } catch (error) {
        if (current) {
          try { client.rename(current.id, manifestName) }
          catch (restoreError) { throw new Error(`Manifest switch and rollback failed; restore asset ${current.id} to ${manifestName}: ${restoreError.message}`, { cause: error }) }
        }
        throw error
      }
    } finally { await rm(temporary, { recursive: true, force: true }) }
  }
  if (release.draft) client.publish(release.id)
  return `https://github.com/${TEST_REPOSITORY}/releases/tag/${tag}`
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length && args[0] !== '--check')) throw new Error('Only --check is accepted')
  const config = publishConfig(process.env)
  const client = githubClient()
  checkRepository(client)
  if (args[0] === '--check') {
    console.log(`Test upload destination: ${config.url}`)
    return
  }
  const release = await publishFeed(config, client)
  console.log(`Published ${config.target} ${config.version}: ${release}`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `### Desktop update test ${config.version}\n\n[Download test installers](${release})\n\nUpdate feed: \`${config.url}\`\n`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
