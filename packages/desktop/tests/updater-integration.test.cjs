// Runs the compiled production controller with the installed electron-updater.
// Only Electron/OS installation is replaced. HTTP, cancellation, SHA-512,
// metadata parsing, cache validation and platform updater logic are real.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createServer, request } = require('node:http')
const { createHash, randomBytes } = require('node:crypto')
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises')
const { gzipSync } = require('node:zlib')
const fs = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const Module = require('node:module')
const { CancellationToken } = require('electron-updater/out/types')
const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor')

const originalLoad = Module._load
const originalPlatform = process.platform
const originalAutoUpdate = process.env.HERMES_DESKTOP_ENABLE_AUTO_UPDATE
let electron
let realUpdater
Module._load = function (id, parent, ...args) {
  if (id === 'electron') return electron
  if (id === 'electron-updater') return { autoUpdater: realUpdater, CancellationToken }
  return originalLoad.call(this, id, parent, ...args)
}

class LocalHttpExecutor extends ElectronHttpExecutor {
  createRequest(options, callback) {
    assert.equal(options.hostname, '127.0.0.1', 'integration tests must never contact release servers')
    return request(options, callback)
  }
  addRedirectHandlers() {} // Node redirects use HttpExecutor's response handling.
}

async function until(predicate, message) {
  const deadline = Date.now() + 12000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${message}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function fixture(t, mac = false, testSource, linuxArch) {
  const root = await mkdtemp(join(tmpdir(), 'ekko-updater-test-'))
  const writers = []
  const createWriteStream = fs.createWriteStream
  fs.createWriteStream = function (path, ...args) {
    const stream = createWriteStream.call(this, path, ...args)
    if (String(path).startsWith(root)) writers.push(stream)
    return stream
  }
  t.after(() => {
    fs.createWriteStream = createWriteStream
    for (const stream of writers) stream.destroy()
  })
  let bytes = randomBytes(1024 * 1024)
  const fileName = linuxArch ? 'update-1.1.0.AppImage' : mac ? 'update-1.1.0.zip' : 'update-1.1.0.exe'
  let appImageInfo
  if (linuxArch) {
    const originalAppImage = process.env.APPIMAGE
    const originalArch = process.env.TEST_UPDATER_ARCH
    t.after(() => {
      if (originalAppImage === undefined) delete process.env.APPIMAGE
      else process.env.APPIMAGE = originalAppImage
      if (originalArch === undefined) delete process.env.TEST_UPDATER_ARCH
      else process.env.TEST_UPDATER_ARCH = originalArch
    })
    const { appendBlockmap } = require('app-builder-lib/out/targets/differentialUpdateInfoBuilder')
    process.env.APPIMAGE = join(root, 'update-1.0.0.AppImage')
    process.env.TEST_UPDATER_ARCH = linuxArch
    const oldBytes = Buffer.from(bytes)
    oldBytes.fill(0, bytes.length / 2)
    await writeFile(process.env.APPIMAGE, oldBytes)
    await appendBlockmap(process.env.APPIMAGE)
    const newFile = join(root, fileName)
    await writeFile(newFile, bytes)
    appImageInfo = await appendBlockmap(newFile)
    bytes = await fs.promises.readFile(newFile)
  }
  const sha512 = createHash('sha512').update(bytes).digest('base64')
  const control = {
    corrupt: false, rejectSignature: false, slow: true, failPrimary: false, failTest: false, chunked: false, disconnect: false,
    feedUrls: [],
    requests: [], ranges: [], dialogs: [], snapshots: [], downloads: 0, interrupted: 0, blockmaps: false,
    signatureChecks: 0, nativeChecks: 0, nativeServed: false, installs: 0, shutdowns: 0, quitHandlers: [],
  }
  const server = createServer((req, res) => {
    control.requests.push(req.url)
    if (req.headers.range) control.ranges.push(req.headers.range)
    if (control.blockmaps && req.url.endsWith('.blockmap')) {
      const body = gzipSync(JSON.stringify({ version: '2', files: [{
        name: 'file', offset: 0, checksums: ['shared', req.url.includes('1.0.0') ? 'old' : 'new'],
        sizes: [bytes.length / 2, bytes.length / 2],
      }] }))
      res.writeHead(200, { 'content-length': body.length }).end(body)
      return
    }
    if (req.url.includes('.yml')) {
      if ((control.failPrimary && req.url.startsWith('/cf/')) || (control.failTest && req.url.startsWith('/test/'))) {
        res.writeHead(503).end('fixture feed offline')
        return
      }
      const body = JSON.stringify({
        version: '1.1.0', releaseDate: '2026-09-25T00:00:00Z',
        files: [{ url: fileName, sha512, size: bytes.length, ...(appImageInfo ? { blockMapSize: appImageInfo.blockMapSize } : {}) }], path: fileName, sha512,
      })
      res.writeHead(200, { 'content-type': 'text/yaml', 'content-length': Buffer.byteLength(body) }).end(body)
      return
    }
    if (!req.url.endsWith(fileName)) { res.writeHead(404).end(); return }
    control.downloads++
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '')
    const payload = Buffer.from(range ? bytes.subarray(Number(range[1]), Number(range[2]) + 1) : bytes)
    if (control.corrupt) payload[0] ^= 0xff
    res.writeHead(range ? 206 : 200, {
      ...(control.chunked ? {} : { 'content-length': payload.length }),
      ...(range ? { 'content-range': `bytes ${range[1]}-${range[2]}/${bytes.length}` } : {}),
    })
    let offset = 0
    const timer = setInterval(() => {
      res.write(payload.subarray(offset, offset + 65536))
      offset += 65536
      if (control.disconnect && offset >= 131072) { clearInterval(timer); res.destroy(); return }
      if (offset >= payload.length) { clearInterval(timer); res.end() }
    }, control.slow ? 90 : 1)
    res.on('close', () => {
      clearInterval(timer)
      if (offset < payload.length) control.interrupted++
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const native = Object.assign(new EventEmitter(), {
    setFeedURL(options) { native.feed = options },
    checkForUpdates() {
      control.nativeChecks++
      void (async () => {
        const metadata = await fetch(native.feed.url, { headers: native.feed.headers }).then(response => response.json())
        await fetch(metadata.url).then(response => response.arrayBuffer())
        control.nativeServed = true
      })().catch(error => native.emit('error', error))
    },
    quitAndInstall() { control.installs++ },
  })
  electron = {
    app: { isPackaged: true, getAppPath: () => root, getLocale: () => 'en', getVersion: () => '1.0.0' },
    autoUpdater: native,
    dialog: { async showMessageBox(options) {
      control.dialogs.push(options)
      return { response: options.buttons.includes('Download') ? 0 : 1 }
    } },
  }
  Object.defineProperty(process, 'platform', { value: mac ? 'darwin' : 'linux' })
  const { NsisUpdater } = require('electron-updater/out/NsisUpdater')
  const { MacUpdater } = require('electron-updater/out/MacUpdater')
  const { AppImageUpdater } = require('electron-updater/out/AppImageUpdater')
  const config = join(root, 'app-update.yml')
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'UpdaterFixture', version: '1.0.0',
    ...(testSource !== undefined ? { desktopUpdate: testSource } : {}),
  }))
  await writeFile(config, JSON.stringify({ provider: 'generic', url: base, updaterCacheDirName: 'cache', publisherName: 'Fixture' }))
  const adapter = {
    name: 'UpdaterFixture', version: '1.0.0', isPackaged: true,
    userDataPath: join(root, 'user'), baseCachePath: root, appUpdateConfigPath: config,
    whenReady: async () => {}, onQuit: handler => control.quitHandlers.push(handler),
    quit: () => { throw new Error('Tests must not quit the app') },
  }
  realUpdater = linuxArch ? new AppImageUpdater(undefined, adapter) : mac ? new MacUpdater(undefined, adapter) : new NsisUpdater(undefined, adapter)
  realUpdater.httpExecutor = new LocalHttpExecutor()
  realUpdater.logger = null
  realUpdater.disableDifferentialDownload = true
  if (!mac) {
    realUpdater.verifyUpdateCodeSignature = async () => {
      control.signatureChecks++
      return control.rejectSignature ? 'fixture signature rejected' : null
    }
    // Replace the OS installation action for NSIS/AppImage.
    realUpdater.quitAndInstall = () => { control.installs++ }
  }
  const setFeed = realUpdater.setFeedURL.bind(realUpdater)
  realUpdater.setFeedURL = ({ url }) => {
    control.feedUrls.push(url)
    const path = url.startsWith('https://updates.example.com/') ? 'test' : url.includes('github.com') ? 'gh' : 'cf'
    setFeed({ provider: 'generic', url: `${base}/${path}` })
  }
  const controllerPath = require.resolve('../dist/main/updater.js')
  delete require.cache[controllerPath]
  process.env.HERMES_DESKTOP_ENABLE_AUTO_UPDATE = 'false'
  const controller = require(controllerPath)
  controller.initAutoUpdater({
    onStateChange: state => control.snapshots.push(state),
    beforeQuitAndInstall: () => { control.shutdowns++ },
  })
  const updater = realUpdater
  t.after(async () => {
    controller.cancelDesktopUpdateDownload()
    if (controller.getDesktopUpdateState().status === 'preparing') native.emit('error', new Error('fixture cleanup'))
    await until(() => !['downloading', 'cancelling', 'preparing'].includes(controller.getDesktopUpdateState().status), 'fixture stopped')
    updater.closeServerIfExists?.()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    if (originalAutoUpdate === undefined) delete process.env.HERMES_DESKTOP_ENABLE_AUTO_UPDATE
    else process.env.HERMES_DESKTOP_ENABLE_AUTO_UPDATE = originalAutoUpdate
    await rm(root, { recursive: true, force: true })
  })
  return { control, controller, updater, native, writers, root, bytes, ready: status => until(() => controller.getDesktopUpdateState().status === status, status) }
}

test('real AppImage embedded differential download cancels and retries for both Linux channels', { timeout: 30000 }, async t => {
  for (const arch of ['x64', 'arm64']) await t.test(arch, async t => {
    const { control, controller, updater, writers, bytes, ready } = await fixture(t, false,
      { channel: 'test', url: `https://updates.example.com/linux-${arch}/` }, arch)
    const oldFile = process.env.APPIMAGE
    const original = fs.readFileSync(oldFile)
    updater.disableDifferentialDownload = false
    await controller.checkForDesktopUpdates(false)
    await until(() => control.ranges.length >= 2 && writers.some(stream => stream.bytesWritten > 0), 'AppImage differential transfer started')
    controller.cancelDesktopUpdateDownload()
    await ready('cancelled')
    await until(() => control.interrupted >= 1, 'AppImage range request aborted')
    // DifferentialDownloader closes its raw descriptors directly on error;
    // WriteStream.closed does not reflect that external close.
    await until(() => writers.every(stream => {
      if (stream.closed) return true
      try { fs.fstatSync(stream.fd); return false } catch (error) {
        if (error.code !== 'EBADF') throw error
        return true
      }
    }), 'AppImage file descriptors closed after cancellation')
    // Do not destroy these externally closed streams during fixture cleanup:
    // their stale descriptor numbers can be reused by the retry.
    writers.length = 0
    assert.equal(updater.autoInstallOnAppQuit, false)
    assert.equal(control.installs, 0)
    assert.deepEqual(fs.readFileSync(oldFile), original)
    control.slow = false
    controller.downloadDesktopUpdate()
    await ready('downloaded')
    assert.deepEqual(fs.readFileSync(updater.installerPath), bytes)
    if (originalPlatform !== 'win32') assert.equal(fs.statSync(updater.installerPath).mode & 0o777, 0o755)
    assert.equal(control.downloads, control.ranges.length, 'AppImage retry must use real embedded-blockmap ranges, not full-download fallback')
    assert(control.requests.some(url => url.startsWith(`/test/latest-linux${arch === 'x64' ? '' : '-arm64'}.yml`)))
    assert(control.requests.every(url => url.startsWith('/test/')))
    assert.equal(control.installs, 0)
  })
})

test('real HTTP progress, fallback feed, cancellation and retry', { timeout: 20000 }, async t => {
  const { control, controller, updater, writers, ready } = await fixture(t)
  control.failPrimary = true
  await controller.checkForDesktopUpdates(false)
  await until(() => controller.getDesktopUpdateState().bytesPerSecond > 0, 'real progress')
  assert(control.requests.some(url => url.startsWith('/cf/')))
  assert(control.requests.some(url => url.startsWith('/gh/')))
  assert.equal(controller.cancelDesktopUpdateDownload().status, 'cancelling')
  await ready('cancelled')
  await until(() => control.interrupted === 1, 'HTTP request aborted')
  await until(() => writers.every(stream => stream.closed), 'cancelled file handles closed')
  assert.equal(updater.autoInstallOnAppQuit, false)
  assert.equal(control.quitHandlers.length, 0)
  control.slow = false
  controller.downloadDesktopUpdate()
  await ready('downloaded')
  assert.equal(control.downloads, 2)
  assert.equal(control.signatureChecks, 1)
  assert.equal(control.quitHandlers.length, 1)
  assert.equal(control.installs, 0)
  assert(!control.dialogs.some(dialog => dialog.type === 'error'))
})

test('packaged test source downloads exclusively through its own feed', { timeout: 20000 }, async t => {
  const { control, controller, ready } = await fixture(t, false, { channel: 'test', url: 'https://updates.example.com/windows/' })
  control.slow = false
  await controller.checkForDesktopUpdates(false)
  await ready('downloaded')
  assert.deepEqual(control.feedUrls, ['https://updates.example.com/windows/'])
  assert(control.requests.length >= 2)
  assert(control.requests.every(url => url.startsWith('/test/')))
})

test('offline test feed never retries against production and can recover on the same feed', { timeout: 20000 }, async t => {
  const { control, controller, ready } = await fixture(t, false, { channel: 'test', url: 'https://updates.example.com/windows/' })
  control.failTest = true
  await assert.rejects(controller.checkForDesktopUpdates(true), /503/)
  assert.deepEqual(control.feedUrls, ['https://updates.example.com/windows/'])
  assert(control.requests.every(url => url.startsWith('/test/')))
  assert.equal(control.downloads, 0)
  assert(control.dialogs.some(dialog => dialog.type === 'error'))
  control.failTest = false
  control.slow = false
  await controller.checkForDesktopUpdates(false)
  await ready('downloaded')
  assert.deepEqual(control.feedUrls, Array(2).fill('https://updates.example.com/windows/'))
})

test('broken test metadata refuses all update requests instead of using production', async t => {
  const { control, controller, root } = await fixture(t, false, { channel: 'test' })
  await assert.rejects(controller.checkForDesktopUpdates(false), /configuration/)
  await writeFile(join(root, 'package.json'), '{broken')
  await assert.rejects(controller.checkForDesktopUpdates(false))
  await rm(join(root, 'package.json'))
  await assert.rejects(controller.checkForDesktopUpdates(false))
  assert.deepEqual(control.feedUrls, [])
  assert.deepEqual(control.requests, [])
})

test('real SHA-512 and signature failures never become installable and can retry', { timeout: 20000 }, async t => {
  const { control, controller, updater, ready } = await fixture(t)
  control.slow = false
  control.corrupt = true
  await controller.checkForDesktopUpdates(false)
  await ready('error')
  assert.equal(control.signatureChecks, 0)
  assert.equal(updater.autoInstallOnAppQuit, false)
  control.corrupt = false
  control.rejectSignature = true
  controller.downloadDesktopUpdate()
  await ready('error')
  assert.equal(control.signatureChecks, 1)
  assert.equal(control.quitHandlers.length, 0)
  assert.equal(control.dialogs.filter(dialog => dialog.type === 'error').length, 2)
  control.rejectSignature = false
  controller.downloadDesktopUpdate()
  await ready('downloaded')
  assert.equal(control.installs, 0)
  assert.equal(control.shutdowns, 0)
})

test('cancellation at completion suppresses auto-install and a retry reuses verified cache', { timeout: 20000 }, async t => {
  const { control, controller, updater, ready } = await fixture(t)
  control.slow = false
  updater.prependOnceListener('update-downloaded', () => controller.cancelDesktopUpdateDownload())
  await controller.checkForDesktopUpdates(false)
  await ready('cancelled')
  assert.equal(updater.autoInstallOnAppQuit, false)
  assert.equal(control.quitHandlers.length, 0)
  assert.equal(control.downloads, 1)
  controller.downloadDesktopUpdate()
  await ready('downloaded')
  assert.equal(control.downloads, 1, 'retry should use the real updater cache')
  assert.equal(control.quitHandlers.length, 1)
})

test('unknown-length cancellation and connection loss close files before retry', { timeout: 20000 }, async t => {
  const { control, controller, writers, ready } = await fixture(t)
  control.chunked = true
  await controller.checkForDesktopUpdates(false)
  await until(() => writers.some(stream => stream.bytesWritten > 0), 'chunked download started')
  assert.equal(controller.getDesktopUpdateState().percent, null)
  controller.cancelDesktopUpdateDownload()
  await ready('cancelled')
  await until(() => writers.every(stream => stream.closed), 'chunked files closed')
  control.disconnect = true
  controller.downloadDesktopUpdate()
  await ready('error')
  await until(() => writers.every(stream => stream.closed), 'disconnected files closed')
  control.disconnect = false
  control.slow = false
  controller.downloadDesktopUpdate()
  await ready('downloaded')
  assert.equal(control.shutdowns, 0)
})

test('real differential download aborts its range request and retries without a full download', { timeout: 20000 }, async t => {
  const { control, controller, updater, root, bytes, ready } = await fixture(t)
  control.blockmaps = true
  updater.disableDifferentialDownload = false
  await mkdir(join(root, 'cache'), { recursive: true })
  const oldInstaller = Buffer.from(bytes)
  oldInstaller.fill(0, bytes.length / 2)
  await writeFile(join(root, 'cache', 'installer.exe'), oldInstaller)
  await controller.checkForDesktopUpdates(false)
  await until(() => control.ranges.length === 1, 'differential range started')
  controller.cancelDesktopUpdateDownload()
  await ready('cancelled')
  await until(() => control.interrupted === 1, 'range request aborted')
  control.slow = false
  controller.downloadDesktopUpdate()
  await ready('downloaded')
  assert.deepEqual(control.ranges, ['bytes=524288-1048575', 'bytes=524288-1048575'])
  assert.equal(control.downloads, 2, 'both attempts should only download the changed range')
  assert.equal(control.signatureChecks, 1)
})

test('real MacUpdater proxy waits for native verification, handles errors, and retries', { timeout: 20000 }, async t => {
  const { control, controller, native, ready } = await fixture(t, true)
  control.slow = false
  await controller.checkForDesktopUpdates(false)
  await until(() => control.nativeServed, 'Squirrel ZIP transfer')
  await ready('preparing')
  assert.equal(control.dialogs.length, 1, 'must not offer restart before native signature verification')
  await controller.installDesktopUpdate()
  assert.equal(control.shutdowns, 0)
  native.emit('error', new Error('fixture native signature failure'))
  await ready('error')
  control.nativeServed = false
  controller.downloadDesktopUpdate()
  await until(() => control.nativeServed, 'second Squirrel ZIP transfer')
  native.emit('update-downloaded')
  await ready('downloaded')
  assert.equal(control.downloads, 1, 'Mac retry should use the SHA-512-validated cache')
  electron.dialog.showMessageBox = async () => ({ response: 0 })
  await controller.installDesktopUpdate()
  assert.equal(control.shutdowns, 1)
  assert.equal(control.installs, 1)
})

test.after(() => { Module._load = originalLoad })
