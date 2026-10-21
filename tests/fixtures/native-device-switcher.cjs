const { app, BrowserWindow, WebContentsView } = require('electron')
const { createServer } = require('node:http')
const { join } = require('node:path')
const fs = require('node:fs')
const assert = require('node:assert/strict')
const clickNative = require('./native-device-pointer.cjs')
const [root, bundle] = process.argv.slice(2)
app.setPath('userData', join(root, 'electron'))
app.commandLine.appendSwitch('disable-gpu')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function capture(window, name) {
  // DOM updates precede the compositor frame used by capturePage.
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  fs.writeFileSync(join(require('node:os').tmpdir(), name), (await window.webContents.capturePage()).toPNG())
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) { try { if (await predicate()) return } catch {} await sleep(50) }
  throw new Error('Native device UI did not become ready')
}
let controller, server
;(async () => {
  await app.whenReady()
  const { NativeDeviceSwitcher, DesktopRemoteDevices } = require(bundle)
  let restarts = 0, pendingCheck = null
  server = createServer((_req, response) => {
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
    response.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><style>:root{--bg-primary:#fafafa;--bg-card:#fff;--bg-input:#fff;--bg-main-surface-rgb:255,255,255;--bg-card-rgb:255,255,255;--text-primary:#1a1a1a;--text-secondary:#666;--accent-primary:#333;--text-on-accent:#fff;--error:#c62828;--border-color:#e0e0e0;--radius-component:6px}html.dark{--bg-primary:#1a1a1a;--bg-card:#2a2a2a;--bg-input:#2a2a2a;--text-primary:#e0e0e0;--text-secondary:#a0a0a0;--accent-primary:#e0e0e0;--text-on-accent:#1a1a1a;--border-color:#3a3a3a}header{padding:0 16px;-webkit-app-region:drag}.studio-page-header{-webkit-app-region:drag}</style></head><body style="margin:0;background:#f6f6f6"><div id="app"><div class="studio-page-header" style="display:flex;position:absolute;left:64px;right:0;top:0;height:40px;box-sizing:border-box"><header style="flex:1;min-width:0;display:flex;justify-content:space-between"><span>Old remote Studio</span><button id="business-action">Action</button></header><div style="width:138px;position:absolute;right:0;height:40px">—　□　×</div></div></div></body></html>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const remote = `http://127.0.0.1:${server.address().port}`
  const devices = new DesktopRemoteDevices({ home: join(root, 'state'), activeServerUrl: remote, env: {}, checkReady: () => new Promise((resolve, reject) => { pendingCheck = { resolve, reject } }), restart: () => { restarts++;return true } })
  const main = new BrowserWindow({ width: 1000, height: 700, frame: false, show: true, webPreferences: { contextIsolation: true, sandbox: true } })
  controller = new NativeDeviceSwitcher(main, () => devices, 'win32')
  assert.equal(controller.view.getVisible(), false, 'hidden before loading')
  await main.loadURL('data:text/html,<body>Checking runtime…</body>')
  await sleep(150)
  assert.equal(controller.view.getVisible(), false, 'normal splash must not show a device dropdown')
  await main.loadURL(remote)
  await until(() => controller.view.getVisible())
  const native = controller.view.webContents
  await until(() => native.executeJavaScript("Boolean(window.studioDevices && document.getElementById('device-label').textContent !== 'Ekko Studio')"))
  await until(() => native.executeJavaScript("window.studioDevices.state().then(data => data.locale === 'en')"))
  const initial = await native.executeJavaScript('window.studioDevices.state()')
  assert.equal(initial.labels.confirm, 'Switch and restart')
  assert.equal(initial.state.activeServerUrl, remote)
  await until(() => main.webContents.executeJavaScript("getComputedStyle(document.querySelector('.studio-page-header')).paddingRight === '266px'"))
  assert.equal(await main.webContents.executeJavaScript('typeof window.studioDevices'), 'undefined')
  const actionRight = await main.webContents.executeJavaScript("document.getElementById('business-action').getBoundingClientRect().right")
  assert.equal(controller.view.getBounds().x - actionRight, 8)
  main.setSize(800, 650)
  await until(() => controller.view.getBounds().x === main.getContentSize()[0] - 266)
  // A native browser tab may be added later. Raising the switcher keeps it above that view.
  const overlay = new WebContentsView()
  main.contentView.addChildView(overlay);controller.raise()
  assert.equal(main.contentView.children.at(-1), controller.view)
  main.contentView.removeChildView(overlay);overlay.webContents.close()
  await clickNative(main, controller.view, '#device-button', root)
  await until(() => native.executeJavaScript("document.getElementById('device-button').getAttribute('aria-expanded') === 'true' && !document.getElementById('device-menu').hidden"))
  assert.equal(controller.view.getBounds().width, 224)
  assert.equal(await native.executeJavaScript("getComputedStyle(document.getElementById('device-button')).webkitAppRegion"), 'no-drag')
  // Actual pointer events travel through the toolbar IPC, menu, and manage action.
  await clickNative(main, controller.view, '.menu-manage', root)
  await until(() => Promise.resolve(BrowserWindow.getAllWindows().some(window => window !== main)))
  const management = BrowserWindow.getAllWindows().find(window => window !== main)
  await until(() => management.webContents.executeJavaScript("Boolean(window.studioDevices && document.querySelector('#devices .device'))"))
  await management.webContents.executeJavaScript("document.getElementById('add-form').requestSubmit()")
  await until(() => management.webContents.executeJavaScript("window.studioDevices.state().then(data => !document.getElementById('message').hidden && document.getElementById('message').textContent === data.labels.invalid)"))
  const languages = ['en','zh','zh-TW','ja','ko','fr','es','de','pt','ru','ar','tr'];
  for (const locale of languages) {
    await main.webContents.executeJavaScript(`document.documentElement.lang = ${JSON.stringify(locale)}`);
    await until(() => management.webContents.executeJavaScript(`window.studioDevices.state().then(data => data.locale === ${JSON.stringify(locale)} && document.documentElement.lang === data.locale && document.documentElement.dir === (data.locale === 'ar' ? 'rtl' : 'ltr') && document.getElementById('title').textContent === data.labels.manageTitle)`));
    const labels = (await native.executeJavaScript('window.studioDevices.state()')).labels;
    assert.equal(management.getTitle(), labels.manageTitle);
    assert.equal(await native.executeJavaScript("document.querySelector('.menu-manage').textContent"), labels.manageTitle);
    assert.equal(await management.webContents.executeJavaScript("document.getElementById('message').textContent"), labels.invalid, 'existing errors follow language changes');
    if (locale === 'ar') {
      management.setSize(460,620);await sleep(100);
      assert.equal(await management.webContents.executeJavaScript('document.documentElement.scrollWidth <= innerWidth'), true);
      await capture(management, 'studio-native-device-manager-arabic.png');
      management.setSize(680,620);
    }
  }
  await main.webContents.executeJavaScript("document.documentElement.lang='en'");
  await until(() => management.webContents.executeJavaScript("document.documentElement.lang === 'en'"));
  fs.writeFileSync(join(require('node:os').tmpdir(), 'studio-native-device-header-win32.png'), (await main.capturePage()).toPNG())
  fs.writeFileSync(join(require('node:os').tmpdir(), 'studio-native-device-manager.png'), (await management.capturePage()).toPNG())
  // The isolated views inherit Studio colors and regional overrides live.
  async function expectTheme(script, selector, property, value) {
    await main.webContents.executeJavaScript(script)
    await until(() => native.executeJavaScript(`getComputedStyle(document.querySelector(${JSON.stringify(selector)}))[${JSON.stringify(property)}] === ${JSON.stringify(value)}`))
  }
  await expectTheme("document.documentElement.classList.add('dark')", '#device-button', 'color', 'rgb(224, 224, 224)')
  await until(() => management.webContents.executeJavaScript("getComputedStyle(document.body).backgroundColor === 'rgb(26, 26, 26)'"))
  await expectTheme("document.documentElement.className = 'theme-has-custom-background';document.documentElement.style.cssText = '--text-primary:#17324d;--accent-primary:#7249c7;--theme-overlay-bg:rgba(201,220,238,.35);--theme-overlay-border:rgba(80,100,120,.35);--theme-overlay-radius:17px;--theme-overlay-filter:blur(9px) saturate(1.1);--theme-overlay-shadow:0 8px 24px rgba(0,0,0,.2);--theme-card-bg:rgba(170,190,210,.2);--theme-card-radius:13px;--theme-input-bg:rgba(140,170,200,.25);--theme-input-radius:11px;--border-width:2px'", '#device-button', 'color', 'rgb(23, 50, 77)')
  await until(() => management.webContents.executeJavaScript("getComputedStyle(document.querySelector('.device')).borderRadius === '13px' && getComputedStyle(document.querySelector('input')).borderRadius === '11px'"))
  management.hide()
  await clickNative(main, controller.view, '#device-button', root)
  await until(() => native.executeJavaScript("!document.getElementById('device-menu').hidden && getComputedStyle(document.getElementById('device-menu')).backgroundColor === 'rgba(201, 220, 238, 0.35)'"))
  assert.equal(await native.executeJavaScript("getComputedStyle(document.getElementById('device-menu')).borderRadius"), '17px')
  assert.equal(await native.executeJavaScript("getComputedStyle(document.getElementById('device-menu')).borderTopWidth"), '2px')
  fs.writeFileSync(join(require('node:os').tmpdir(), 'studio-native-device-menu-themed.png'), (await native.capturePage()).toPNG())
  await expectTheme("document.documentElement.style.setProperty('--theme-overlay-bg','rgba(201,220,238,0)');document.documentElement.style.setProperty('--theme-overlay-border','rgba(80,100,120,0)')", '#device-menu', 'backgroundColor', 'rgba(201, 220, 238, 0)')
  assert.equal(await native.executeJavaScript("getComputedStyle(document.getElementById('device-menu')).borderTopColor"), 'rgba(80, 100, 120, 0)')
  await expectTheme("document.documentElement.style.cssText='';document.documentElement.className=''", '#device-menu', 'backgroundColor', 'rgb(255, 255, 255)')
  await native.executeJavaScript('window.studioDevices.dismiss()')
  management.show()
  await management.webContents.executeJavaScript("document.getElementById('toggle-add').click()")
  const dangerousName = 'Office </script><img src=x onerror=alert(1)>'
  await management.webContents.executeJavaScript(`document.getElementById('name').value = ${JSON.stringify(dangerousName)};document.getElementById('address').value = 'http://office.example.com';document.getElementById('add-form').requestSubmit()`)
  await until(() => Promise.resolve(devices.state().devices.length === 2))
  await until(() => management.webContents.executeJavaScript("document.querySelectorAll('#devices .device').length === 3"))
  assert.equal(await management.webContents.executeJavaScript("document.querySelectorAll('img').length"), 0)
  assert.equal(await management.webContents.executeJavaScript("[...document.querySelectorAll('.name')].some(el => el.textContent.includes('</script>'))"), true)
  const office = devices.state().devices.find(device => device.name === dangerousName)
  management.hide();
  await clickNative(main, controller.view, '#device-button', root);
  await until(() => native.executeJavaScript(`!!document.querySelector('[data-device-id="${office.id}"]') && !document.getElementById('device-menu').hidden`));
  assert.equal(await native.executeJavaScript(`(() => { const item = document.querySelector('[data-device-id="${office.id}"]');const name = item.querySelector('.menu-name');return item.title.includes(${JSON.stringify(dangerousName)}) && name.scrollWidth > name.clientWidth && getComputedStyle(name).textOverflow === 'ellipsis' })()`), true);
  assert.equal(await native.executeJavaScript("getComputedStyle(document.getElementById('device-button')).width"), '120px');
  fs.writeFileSync(join(require('node:os').tmpdir(), 'studio-native-device-menu-compact.png'), (await native.capturePage()).toPNG());
  await native.executeJavaScript('window.studioDevices.dismiss()');management.show();
  const actionWindow = () => BrowserWindow.getAllWindows().find(window => window.isModal());
  async function readyAction() {
    await until(() => actionWindow()?.webContents.executeJavaScript("Boolean(window.studioDevices && document.getElementById('target-name').textContent)"));
    return actionWindow();
  }
  const clickWindow = (window, selector) => clickNative(window, { webContents: window.webContents, getBounds: () => ({ x:0, y:0 }) }, selector, root);
  // A pending connection check must visibly spin; elapsed time keeps moving.
  await management.webContents.executeJavaScript(`document.querySelector('[data-device-id="${office.id}"] [data-action="switch"]').click()`);
  const switching = await readyAction();
  assert.equal(restarts, 0);assert.equal(pendingCheck, null, 'confirmation precedes all network checks');
  assert.equal(await switching.webContents.executeJavaScript('document.getElementById("target-name").textContent'), dangerousName);
  for (const locale of ['en','es','ar','zh-TW','ru','tr']) {
    await main.webContents.executeJavaScript(`document.documentElement.lang = ${JSON.stringify(locale)}`);
    await until(() => switching.webContents.executeJavaScript(`window.studioDevices.state().then(data => data.locale === ${JSON.stringify(locale)} && document.documentElement.lang === data.locale && document.documentElement.dir === (data.locale === 'ar' ? 'rtl' : 'ltr') && document.getElementById('action-title').textContent === data.labels.switchTitle && document.getElementById('action-confirm').textContent === data.labels.confirm)`));
    const labels = (await switching.webContents.executeJavaScript('window.studioDevices.state()')).labels;
    assert.equal(switching.getTitle(), labels.switchTitle);
    assert.equal(await switching.webContents.executeJavaScript('document.documentElement.scrollWidth <= innerWidth'), true);
    if (locale === 'ar') await capture(switching, 'studio-native-device-confirmation-arabic.png');
  }
  await main.webContents.executeJavaScript("document.documentElement.lang='en'");
  await until(() => switching.webContents.executeJavaScript("document.documentElement.lang === 'en'"));
  await capture(switching, 'studio-native-device-confirmation.png');
  await main.webContents.executeJavaScript("document.documentElement.classList.add('dark')");
  await until(() => switching.webContents.executeJavaScript("getComputedStyle(document.getElementById('action-shell')).backgroundColor === 'rgb(42, 42, 42)'"));
  await capture(switching, 'studio-native-device-confirmation-dark.png');
  await main.webContents.executeJavaScript("document.documentElement.classList.add('theme-has-custom-background');document.documentElement.style.setProperty('--theme-overlay-bg','rgba(90,110,130,0)');document.documentElement.style.setProperty('--theme-card-radius','15px')");
  await until(() => switching.webContents.executeJavaScript("getComputedStyle(document.getElementById('action-shell')).backgroundColor === 'rgba(90, 110, 130, 0)' && getComputedStyle(document.querySelector('.target-device')).borderRadius === '15px'"));
  await main.webContents.executeJavaScript("document.documentElement.className='';document.documentElement.style.cssText=''");
  await until(() => switching.webContents.executeJavaScript("getComputedStyle(document.getElementById('action-shell')).backgroundColor === 'rgb(255, 255, 255)'"));
  if (process.env.STUDIO_TEST_REDUCED_MOTION === '1') {
    switching.webContents.debugger.attach('1.3');
    await switching.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name:'prefers-reduced-motion', value:'reduce' }] });
  }
  await clickWindow(switching, '#action-confirm');
  await until(() => switching.webContents.executeJavaScript("window.studioDevices.state().then(data => data.busy && data.operation.stage === 'checking' && !document.getElementById('progress').hidden && getComputedStyle(document.querySelector('#progress .spinner')).animationName === (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'none' : 'device-spin'))"));
  const reducedMotion = await switching.webContents.executeJavaScript("matchMedia('(prefers-reduced-motion: reduce)').matches");
  assert.ok(pendingCheck);
  assert.equal(await switching.webContents.executeJavaScript("getComputedStyle(document.getElementById('action-confirm')).display === 'none' && getComputedStyle(document.getElementById('action-cancel')).display === 'none' && document.documentElement.scrollHeight <= innerHeight"), true);
  assert.equal(await native.executeJavaScript("document.getElementById('device-button').disabled && !!document.querySelector('#toolbar-icon .spinner')"), true);
  assert.equal(await switching.webContents.executeJavaScript("window.studioDevices.state().then(data => window.studioDevices.confirm(data.operation.token)).then(() => false, () => true)"), true);
  switching.close();assert.equal(switching.isDestroyed(), false, 'do not hide an active check');
  await main.webContents.executeJavaScript("document.documentElement.lang='es'");
  await until(() => switching.webContents.executeJavaScript("window.studioDevices.state().then(data => data.locale === 'es' && document.getElementById('progress-title').textContent === data.labels.busy && document.getElementById('restart-label').textContent === data.labels.restartStudio)"));
  await until(() => switching.webContents.executeJavaScript("/[1-9]/.test(document.getElementById('elapsed').textContent)"));
  await capture(switching, 'studio-native-device-checking.png');
  pendingCheck.reject(new Error('offline'));pendingCheck = null;
  await until(() => switching.webContents.executeJavaScript("window.studioDevices.state().then(data => !data.busy && data.operation.stage === 'error' && !document.getElementById('action-error').hidden && document.getElementById('action-error').textContent === data.labels.unreachable)"));
  assert.equal(restarts, 0);assert.equal(devices.state().activeServerUrl, remote);
  await capture(switching, 'studio-native-device-failed.png');
  // Retry remains in the same themed window, without a blocking system dialog.
  await clickWindow(switching, '#action-confirm');
  await until(() => Promise.resolve(Boolean(pendingCheck)));
  pendingCheck.reject(new Error('still offline'));pendingCheck = null;
  // The main-process error stage arrives before the renderer shows/enables Close.
  await until(() => switching.webContents.executeJavaScript("window.studioDevices.state().then(data => data.operation.stage === 'error' && !document.getElementById('action-cancel').hidden && !document.getElementById('action-cancel').disabled)"));
  await clickWindow(switching, '#action-cancel');
  await until(() => Promise.resolve(switching.isDestroyed()));
  // Remote DOM reload/failure and renderer crash do not replace the desktop-owned view.
  await main.loadURL('http://127.0.0.1:1').catch(() => {})
  assert.equal(controller.view.getVisible(), true, 'a failed remote reload must keep recovery available')
  await main.loadURL('data:text/html,<body>Failed to connect. Retry / Return local</body>')
  assert.equal(controller.view.getVisible(), false)
  controller.setVisible(true)
  assert.equal(controller.view.getVisible(), true, 'recovery page must keep a local switcher')
  assert.equal((await native.executeJavaScript('window.studioDevices.state()')).state.activeServerUrl, remote)
  main.webContents.forcefullyCrashRenderer()
  await sleep(150)
  management.hide()
  await clickNative(main, controller.view, '#device-button', root)
  await until(() => native.executeJavaScript("!document.getElementById('device-menu').hidden"))
  await native.executeJavaScript('window.studioDevices.dismiss()')
  management.show()
  assert.equal(await native.executeJavaScript("document.getElementById('device-button').disabled"), false)
  assert.equal((await native.executeJavaScript('window.studioDevices.state()')).locale, 'es', 'offline and renderer crash preserve the selected app language')
  // Forging the preload in a different local view still cannot access the native IPC.
  const impostor = new BrowserWindow({ show: false, webPreferences: { preload: join(root, 'preload', 'native-devices.js'), sandbox: true, contextIsolation: true } })
  await impostor.loadURL('data:text/html,<body>Untrusted local window</body>')
  assert.equal(await impostor.webContents.executeJavaScript("window.studioDevices.state().then(() => false, () => true)"), true)
  impostor.destroy()
  // Delete consent is local and cancellation preserves the saved connection.
  await management.webContents.executeJavaScript(`document.querySelector('[data-device-id="${office.id}"] [data-action="remove"]').click()`);
  const deleting = await readyAction();
  await clickWindow(deleting, '#action-cancel');
  await until(() => Promise.resolve(deleting.isDestroyed()));
  assert.equal(devices.state().devices.length, 2);
  await management.webContents.executeJavaScript(`document.querySelector('[data-device-id="${office.id}"] [data-action="remove"]').click()`);
  const confirmedDelete = await readyAction();
  await clickWindow(confirmedDelete, '#action-confirm');
  await until(() => Promise.resolve(devices.state().devices.length === 1));
  await until(() => management.webContents.executeJavaScript("document.querySelectorAll('#devices .device').length === 2"));
  // Returning local uses the compact menu and keeps restart feedback onscreen.
  management.destroy();controller.openManager();
  const reopened = BrowserWindow.getAllWindows().find(window => window !== main);
  await until(() => reopened.webContents.executeJavaScript('Boolean(window.studioDevices)'));
  reopened.hide();
  await clickNative(main, controller.view, '#device-button', root);
  await until(() => native.executeJavaScript("!document.getElementById('device-menu').hidden"));
  await clickNative(main, controller.view, '[data-device-id="local"]', root);
  const returning = await readyAction();
  await clickWindow(returning, '#action-cancel');
  await until(() => Promise.resolve(returning.isDestroyed()));
  assert.equal(restarts, 0);
  await native.executeJavaScript('window.studioDevices.switchTo(null)');
  const accepted = await readyAction();
  await clickWindow(accepted, '#action-confirm');
  await until(() => accepted.webContents.executeJavaScript("window.studioDevices.state().then(data => data.operation.stage === 'restarting' && !document.getElementById('progress').hidden && document.getElementById('progress-title').textContent === data.labels.restarting)"));
  await capture(accepted, 'studio-native-device-restarting.png');
  assert.equal(restarts, 1);
  assert.equal(JSON.parse(fs.readFileSync(join(root, 'state', 'desktop-remote-server.json'))).serverUrl, null);
  controller.dispose()
  const local = new DesktopRemoteDevices({ home: join(root, 'state'), activeServerUrl: null, env: {}, checkReady: async () => {}, restart: () => true })
  controller = new NativeDeviceSwitcher(main, () => local, 'darwin')
  await main.loadURL(remote)
  await until(() => controller.view.webContents.executeJavaScript("window.studioDevices.state().then(data => document.getElementById('device-label').textContent === data.labels.local)"))
  assert.equal(controller.view.getBounds().x, main.getContentSize()[0] - 128)
  await sleep(100)
  fs.writeFileSync(join(require('node:os').tmpdir(), 'studio-native-device-button-macos.png'), (await controller.view.webContents.capturePage()).toPNG())
  fs.writeFileSync(join(root, 'result.json'), JSON.stringify({ ok: true, oldPage: true, csp: true, offline: true, crash: true, localManager: true, deniedForeignIpc: true, layoutGap: 8, returnedLocal: true, clickedToolbar: true, liveTheme: true, hiddenSplash: true, compactMenu: true, themedConfirmation: true, progressFeedback: true, retryAndCancel: true, liveLocale: true, allTwelveLanguages: true, rtlLayout: true, offlineLocale: true, reducedMotion, osMouse: process.env.STUDIO_TEST_NATIVE_MOUSE === '1' }))
  controller.dispose();main.destroy();await new Promise(resolve => server.close(resolve));app.exit(0)
})().catch(async error => {
  const diagnostics = [];
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      diagnostics.push({ bounds: window.getBounds(), focused: window.isFocused(), modal: window.isModal(), renderer: await window.webContents.executeJavaScript("(async () => ({kind:document.body.className,reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,progressHidden:document.getElementById('progress')?.hidden,animation:document.querySelector('#progress .spinner') && getComputedStyle(document.querySelector('#progress .spinner')).animationName,button:document.getElementById('action-confirm')?.getBoundingClientRect().toJSON(),state:window.studioDevices ? await window.studioDevices.state().then(data => ({busy:data.busy,operation:data.operation}), error => String(error)) : null}))()") });
    } catch (inspectionError) { diagnostics.push({ error:String(inspectionError) }) }
  }
  fs.writeFileSync(join(root, 'result.json'), JSON.stringify({ error: error.stack, diagnostics }));
  try { controller?.dispose() } catch {} app.exit(1)
})
