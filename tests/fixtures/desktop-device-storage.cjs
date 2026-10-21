// Run in an isolated Electron process, twice, to verify Chromium storage and
// persistence rather than reproducing session behavior in a JavaScript mock.
const { app, BrowserWindow, session } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')

const [root, storageModule, phase] = process.argv.slice(2)
const { desktopWindowSession, desktopDeviceStoragePaths } = require(storageModule)
const { BrowserProfileStore } = require(path.join(path.dirname(storageModule), 'browser-profiles.cjs'))
const marker = path.join(root, 'state.json')
const result = path.join(root, 'result.json')
app.setPath('userData', path.join(root, 'electron-user-data'))
app.disableHardwareAcceleration()
const windows = []
let assetBody = 'A'

function listen(port = 0) {
  return new Promise((resolve, reject) => {
    const service = http.createServer((req, res) => {
      if (req.url === '/asset') {
        res.writeHead(200, { 'Cache-Control': 'public, max-age=31536000' })
        res.end(assetBody)
      } else if (req.url === '/worker.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' })
        res.end('self.addEventListener("install", () => self.skipWaiting()); self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));')
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
        res.end('<!doctype html><title>Isolated device storage test</title>')
      }
    })
    service.once('error', reject)
    service.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${service.address().port}`))
  })
}

async function open(home, scope, url, browserSession) {
  const win = new BrowserWindow({ show: false, webPreferences: {
    session: browserSession || desktopWindowSession(home, scope), sandbox: true, contextIsolation: true, nodeIntegration: false,
  } })
  windows.push(win)
  await win.loadURL(url)
  return win
}

async function read(win) {
  return win.webContents.executeJavaScript(`(async () => ({
    token: localStorage.getItem('hermes_api_key'),
    profile: localStorage.getItem('hermes_active_profile_name'),
    cookie: document.cookie,
    databases: (await indexedDB.databases()).map(db => db.name),
    theme: await (await caches.match('/__theme'))?.text() || null,
    workers: (await navigator.serviceWorker.getRegistrations()).length,
  }))()`)
}

async function write(win, label) {
  await win.webContents.executeJavaScript(`(async () => {
    const label = ${JSON.stringify(label)};
    localStorage.setItem('hermes_api_key', label + '-token');
    localStorage.setItem('hermes_active_profile_name', label + '-profile');
    document.cookie = 'auth=' + label + '; Path=/; Max-Age=3600; SameSite=Lax';
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('studio-device-cache', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('settings');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('settings', 'readwrite');
        tx.objectStore('settings').put(label, 'device');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
    await (await caches.open('hermes-theme-background-v1')).put('/__theme', new Response(label));
    await navigator.serviceWorker.register('/worker.js');
    await navigator.serviceWorker.ready;
  })()`)
}

function assertEmpty(value) {
  assert.deepEqual(value, { token: null, profile: null, cookie: '', databases: [], theme: null, workers: 0 })
}

async function assertDevice(win, label) {
  const value = await read(win)
  assert.equal(value.token, label + '-token')
  assert.equal(value.profile, label + '-profile')
  assert.equal(value.cookie, 'auth=' + label)
  assert.deepEqual(value.databases, ['studio-device-cache'])
  assert.equal(value.theme, label)
  assert.equal(value.workers, 1)
  const stored = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const request = indexedDB.open('studio-device-cache', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const read = db.transaction('settings', 'readonly').objectStore('settings').get('device');
      read.onsuccess = () => { db.close(); resolve(read.result); };
    };
  })`)
  assert.equal(stored, label)
}

app.whenReady().then(async () => {
  app.dock?.hide()
  const saved = phase === 'restore' ? JSON.parse(fs.readFileSync(marker, 'utf8')) : null
  const origin = await listen(saved?.port)
  const otherOrigin = await listen(saved?.otherPort)
  const home = path.join(root, 'web-ui-home')
  const a = await open(home, origin + '/a', origin + '/a')
  const b = await open(home, origin + '/b', origin + '/b')
  const c = await open(home, otherOrigin, otherOrigin)
  const local = await open(home, null, origin)
  assert.notEqual(a.webContents.session, b.webContents.session)
  assert.notEqual(a.webContents.session, c.webContents.session)
  assert.notEqual(a.webContents.session, local.webContents.session)
  const secondA = await open(home, origin + '/a/', origin + '/a/#/desktop-chat')
  assert.equal(a.webContents.session, secondA.webContents.session)

  if (phase === 'write') {
    for (const win of [a, b, c, local]) assertEmpty(await read(win))
    await write(a, 'A')
    await assertDevice(secondA, 'A')
    for (const win of [b, c, local]) assertEmpty(await read(win))
    assert.equal(await a.webContents.executeJavaScript('fetch("/asset").then(r => r.text())'), 'A')
    assetBody = 'B'
    assert.equal(await b.webContents.executeJavaScript('fetch("/asset").then(r => r.text())'), 'B')
    assert.equal(await a.webContents.executeJavaScript('fetch("/asset").then(r => r.text())'), 'A')
    await write(b, 'B')
    await write(c, 'C')
    await write(local, 'local')
    fs.writeFileSync(marker, JSON.stringify({ port: Number(new URL(origin).port), otherPort: Number(new URL(otherOrigin).port) }))
  }
  for (const [win, label] of [[a, 'A'], [b, 'B'], [c, 'C'], [local, 'local']]) await assertDevice(win, label)
  for (const [scope, label] of [[origin + '/a', 'A'], [origin + '/b', 'B'], [otherOrigin, 'C'], [null, 'local']]) {
    const paths = desktopDeviceStoragePaths(home, scope)
    const store = new BrowserProfileStore(paths.browserRoot)
    await store.initialize()
    const profile = store.active()
    const tabUrl = origin + '/#/saved-' + label
    if (phase === 'write') {
      await store.renameProfile(profile.id, 'Browser ' + label)
      await store.setTabs(profile.id, [tabUrl])
    }
    assert.equal(store.active().name, 'Browser ' + label)
    assert.deepEqual(store.active().tabs, [tabUrl])
    assert.notEqual(paths.browserRoot, paths.sessionPath)
    const browser = await open(home, null, origin, session.fromPath(profile.sessionPath, { cache: true }))
    if (phase === 'write') {
      assertEmpty(await read(browser))
      await write(browser, 'browser-' + label)
    }
    await assertDevice(browser, 'browser-' + label)
  }
  for (const win of windows) {
    win.webContents.session.flushStorageData()
    await win.webContents.session.cookies.flushStore()
    win.destroy()
  }
  if (phase === 'restore') fs.writeFileSync(result, JSON.stringify({ ok: true, sameOriginPaths: true, sameHostPorts: true,
    sharedDeviceWindows: true, localPreserved: true, httpCacheIsolated: true,
    persisted: ['login', 'profile', 'cookies', 'IndexedDB', 'CacheStorage', 'ServiceWorker', 'browser profiles'] }))
  app.exit(0)
}).catch(error => {
  fs.writeFileSync(result, JSON.stringify({ error: String(error.stack || error) }))
  app.exit(1)
})
