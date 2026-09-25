const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { mkdtemp, readFile, writeFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { basename, join } = require('node:path')
const script = () => import('../scripts/publish-update-test.mjs')
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

async function fixture(t, version = '0.7.900', target = 'darwin-arm64') {
  const { publishConfig } = await script()
  const config = publishConfig({ DESKTOP_UPDATE_TEST_TARGET: target, DESKTOP_UPDATE_TEST_VERSION: version })
  config.feed = await mkdtemp(join(tmpdir(), 'ekko-test-publish-fixture-'))
  t.after(() => rm(config.feed, { recursive: true, force: true }))
  const files = []
  for (const ext of target.startsWith('darwin') ? ['zip', 'dmg'] : ['exe']) {
    const name = `Ekko.Studio-${version}-${target.split('-')[1]}.${ext}`
    const bytes = Buffer.from(`fixture ${name}`)
    await writeFile(join(config.feed, name), bytes)
    await writeFile(join(config.feed, `${name}.blockmap`), `fixture blockmap ${name}`)
    files.push({ url: name, size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64') })
  }
  const manifest = target.startsWith('darwin') ? 'latest-mac.yml' : 'latest.yml'
  await writeFile(join(config.feed, manifest), JSON.stringify({ version, files, path: files[0].url, sha512: files[0].sha512 }))
  await writeFile(join(config.feed, 'update-test-build.json'), JSON.stringify({
    version, target, source: config.metadata.desktopUpdate, manifest,
    artifacts: [manifest, ...files.flatMap(file => [file.url, `${file.url}.blockmap`])],
  }))
  return { ...config, manifest }
}

function fakeGithub() {
  const state = { release: null, assets: [], events: [], nextId: 1, failure: null }
  const event = (action, name) => { state.events.push([action, name]); state.failure?.(action, name) }
  const client = {
    release: () => state.release && { ...state.release },
    create: tag => {
      event('create', tag)
      return state.release = { id: 1, tag_name: tag, draft: true, prerelease: true }
    },
    assets: () => state.assets.map(({ bytes, ...asset }) => ({ ...asset })),
    download: id => state.assets.find(asset => asset.id === id).bytes.toString(),
    upload: (_tag, path) => {
      const name = basename(path)
      event('upload', name)
      assert(!state.assets.some(asset => asset.name === name), 'Existing assets must never be clobbered')
      const bytes = readFileSync(path)
      state.assets.push({ id: state.nextId++, name, bytes, state: 'uploaded', size: bytes.length, digest: digest(bytes) })
    },
    rename: (id, name) => {
      event('rename', name)
      assert(!state.assets.some(asset => asset.id !== id && asset.name === name))
      const asset = state.assets.find(asset => asset.id === id)
      asset.name = name
      return { ...asset }
    },
    publish: () => { event('publish'); state.release.draft = false },
  }
  return { state, client, current: name => state.assets.find(asset => asset.name === name)?.bytes.toString() }
}

test('GitHub publisher fixes the repo and separates all three target feeds', async () => {
  const { TEST_REPOSITORY, publishConfig, checkRepository } = await script()
  assert.equal(TEST_REPOSITORY, 'EKKOLearnAI/ekko-studio-update-test')
  for (const target of ['darwin-arm64', 'darwin-x64', 'win32-x64']) {
    const env = { DESKTOP_UPDATE_TEST_TARGET: target, DESKTOP_UPDATE_TEST_VERSION: '0.7.900' }
    assert.equal(publishConfig(env).url, `https://github.com/${TEST_REPOSITORY}/releases/download/update-test-${target}/`)
    assert.throws(() => publishConfig({ ...env, DESKTOP_UPDATE_TEST_URL: 'https://github.com/EKKOLearnAI/ekko-studio/releases/latest/download/' }), /fixed/)
  }
  let called = false
  assert.throws(() => checkRepository({ repository: () => { called = true } }, { GITHUB_ACTIONS: 'true' }), /DESKTOP_UPDATE_TEST_TOKEN/)
  assert.equal(called, false)
  for (const repo of [{ full_name: 'EKKOLearnAI/ekko-studio' }, { full_name: TEST_REPOSITORY, private: true }, { full_name: TEST_REPOSITORY, archived: true }]) {
    assert.throws(() => checkRepository({ repository: () => repo }, {}), /public test repository/)
  }
})

test('GitHub CLI adapter always uses the test repo, paginates, and never marks latest', async () => {
  const { githubClient, TEST_REPOSITORY } = await script()
  const calls = []
  const client = githubClient((args, input) => {
    calls.push({ args, body: input && JSON.parse(input) })
    if (args.includes('--slurp')) return '[[{"id":1}],[{"id":2}]]'
    return '{}'
  })
  client.repository(); client.release('update-test-darwin-arm64'); client.create('update-test-darwin-arm64')
  assert.deepEqual(client.assets(1), [{ id: 1 }, { id: 2 }])
  client.download(1); client.upload('update-test-darwin-arm64', '/tmp/test.zip'); client.rename(1, 'latest-mac.yml'); client.publish(1)
  for (const call of calls) assert(call.args.some(arg => arg.includes(TEST_REPOSITORY)))
  const changes = calls.filter(call => call.body?.make_latest)
  assert.equal(changes.length, 2)
  for (const change of changes) {
    assert.equal(change.body.prerelease, true)
    assert.equal(change.body.make_latest, 'false')
  }
  assert.equal(githubClient(() => '[[]]').release('test'), null)
  assert.equal(githubClient(() => '[[{"tag_name":"test","id":123,"draft":true}]]').release('test').id, 123)
  assert.throws(() => githubClient(() => { throw new Error('403') }).release('test'), /403/)
})

test('A → B uploads installers first, switches manifest last, retains A, and supports exact retries on every target', async t => {
  const { publishFeed } = await script()
  for (const target of ['darwin-arm64', 'darwin-x64', 'win32-x64']) {
    const a = await fixture(t, '0.7.900', target), b = await fixture(t, '0.7.901', target)
    const { state, client, current } = fakeGithub()
    await publishFeed(a, client)
    assert.equal(state.release.draft, false)
    assert.equal(state.events.at(-1)[0], 'publish')
    assert.equal(current(a.manifest), await readFile(join(a.feed, a.manifest), 'utf8'))
    const oldInstallers = state.assets.filter(asset => asset.name.includes('-0.7.900-')).map(asset => asset.id)
    state.events = []
    await publishFeed(b, client)
    const firstRename = state.events.findIndex(([action]) => action === 'rename')
    assert(state.events.slice(0, firstRename).every(([action]) => action === 'upload'))
    assert.deepEqual(state.events.at(-1), ['rename', b.manifest])
    assert.equal(JSON.parse(current(b.manifest)).version, b.version)
    for (const id of oldInstallers) assert(state.assets.some(asset => asset.id === id))
    state.events = []
    await publishFeed(b, client)
    assert.deepEqual(state.events, [])
    await assert.rejects(publishFeed(a, client), /newer test feed/)
    assert.deepEqual(state.events, [])
  }
})

test('corrupt feed or mismatched build summary cannot create a release', async t => {
  const { publishFeed } = await script()
  for (const corrupt of ['installer', 'summary']) {
    const config = await fixture(t)
    const summary = JSON.parse(await readFile(join(config.feed, 'update-test-build.json'), 'utf8'))
    await writeFile(join(config.feed, corrupt === 'installer' ? summary.artifacts[1] : 'update-test-build.json'), '{}')
    const { state, client } = fakeGithub()
    await assert.rejects(publishFeed(config, client), /mismatch|differs/)
    assert.deepEqual(state.events, [])
  }
})

test('upload or remote checksum failure leaves the old manifest usable', async t => {
  const { publishFeed } = await script()
  for (const fail of ['upload', 'checksum']) {
    const a = await fixture(t), b = await fixture(t, '0.7.901')
    const { state, client, current } = fakeGithub()
    await publishFeed(a, client)
    state.events = []
    if (fail === 'upload') state.failure = action => { if (action === 'upload') throw new Error('network disconnected') }
    else {
      const list = client.assets
      client.assets = () => list().map(asset => asset.name.includes('-0.7.901-') ? { ...asset, digest: 'bad' } : asset)
    }
    await assert.rejects(publishFeed(b, client), /network disconnected|SHA-256/)
    assert.equal(JSON.parse(current(a.manifest)).version, a.version)
    assert(!state.events.some(([action]) => action === 'rename'))
  }
})

test('failed first upload leaves a draft that is reused on retry', async t => {
  const { publishFeed } = await script()
  const a = await fixture(t)
  const { state, client, current } = fakeGithub()
  state.failure = action => { if (action === 'upload') throw new Error('upload failed') }
  await assert.rejects(publishFeed(a, client), /upload failed/)
  assert.equal(state.release.draft, true)
  assert.equal(current(a.manifest), undefined)
  state.failure = null
  await publishFeed(a, client)
  assert.equal(state.release.draft, false)
  assert.equal(state.events.filter(([action]) => action === 'create').length, 1)
})

test('failed manifest switch restores A and the identical B build can retry', async t => {
  const { publishFeed } = await script()
  const a = await fixture(t), b = await fixture(t, '0.7.901')
  const { state, client, current } = fakeGithub()
  await publishFeed(a, client)
  let failed = false
  state.failure = (action, name) => {
    if (action === 'rename' && name === b.manifest && !failed) { failed = true; throw new Error('switch failed') }
  }
  await assert.rejects(publishFeed(b, client), /switch failed/)
  assert.equal(JSON.parse(current(a.manifest)).version, a.version)
  state.failure = null
  await publishFeed(b, client)
  assert.equal(JSON.parse(current(b.manifest)).version, b.version)
})

test('runner termination between renames is recovered before checking for rollback', async t => {
  const { publishFeed } = await script()
  const a = await fixture(t), b = await fixture(t, '0.7.901')
  const { state, client, current } = fakeGithub()
  await publishFeed(b, client)
  const old = state.assets.find(asset => asset.name === b.manifest)
  client.rename(old.id, `previous-${old.id}-${b.manifest}`)
  await assert.rejects(publishFeed(a, client), /newer test feed/)
  assert.equal(JSON.parse(current(b.manifest)).version, b.version)
})

test('same-version rebuilds, asset collisions, and immutable/non-test releases are rejected', async t => {
  const { publishFeed } = await script()
  const a = await fixture(t), b = await fixture(t, '0.7.901')
  const { state, client } = fakeGithub()
  await publishFeed(a, client)
  const manifestPath = join(a.feed, a.manifest)
  const original = await readFile(manifestPath, 'utf8')
  await writeFile(manifestPath, `${original}\n`)
  await assert.rejects(publishFeed(a, client), /different content/)
  await writeFile(manifestPath, original)
  const summary = JSON.parse(await readFile(join(b.feed, 'update-test-build.json'), 'utf8'))
  state.assets.push({ name: summary.artifacts[1], state: 'uploaded', size: 1, digest: 'bad' })
  await assert.rejects(publishFeed(b, client), /overwrite/)
  state.release.immutable = true
  await assert.rejects(publishFeed(a, client), /mutable prerelease/)
  state.release.immutable = false; state.release.prerelease = false
  await assert.rejects(publishFeed(a, client), /mutable prerelease/)
})
