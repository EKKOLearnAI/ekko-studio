/* Run with Electron on an interactive desktop after build:main. This uses production capture/editor IPC. */
const { app, BrowserWindow, desktopCapturer, ipcMain, nativeImage, screen, systemPreferences } = require('electron')
const { writeFile } = require('node:fs/promises')
const { performance } = require('node:perf_hooks')
const { captureRegionScreenshot, cancelRegionScreenshot } = require('../dist/main/screenshot')
const { prepareScreenshotOverlays, disposeScreenshotOverlays } = require('../dist/main/screenshot-windows')
const { screenshotEnvironment } = require('../dist/main/screenshot-platform')

const option = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback
const rounds = Number(option('rounds', '20'))
const output = option('output', '')
const measureLinuxHide = process.argv.includes('--measure-linux-hide')
const labels = { hint: 'Pixel acceptance probe', confirm: 'Done', cancel: 'Cancel', reset: 'Reset' }
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
let marker, background

function difference(before, after, tolerance = 3) {
  if (before.length !== after.length) throw new Error('Captured dimensions changed')
  let changed = 0, maxDelta = 0
  for (let i = 0; i < before.length; i += 4) {
    let delta = 0
    for (let c = 0; c < 3; c++) delta = Math.max(delta, Math.abs(before[i + c] - after[i + c]))
    maxDelta = Math.max(maxDelta, delta)
    if (delta > tolerance) changed++
  }
  return { changedPixels: changed, fraction: changed / (before.length / 4), maxDelta, tolerance }
}

async function run() {
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100) throw new Error('Use --rounds=1..100')
  const capabilities = screenshotEnvironment()
  if (capabilities.presentation !== 'desktop-overlay') throw new Error('Run the overlay pixel probe in a native Windows/macOS/X11 session; Wayland requires interactive Portal acceptance.')
  const display = screen.getPrimaryDisplay()
  const area = { x: 80, y: 80, width: Math.min(640, display.bounds.width - 160), height: Math.min(460, display.bounds.height - 160) }
  background = new BrowserWindow({ ...display.bounds, frame: false, show: false, skipTaskbar: true, backgroundColor: '#204060' })
  await background.loadURL('data:text/html,<body style="margin:0;background:%23204060">')
  background.show()
  marker = new BrowserWindow({ x: display.bounds.x + area.x + 48, y: display.bounds.y + area.y + 48, width: area.width - 96, height: area.height - 96, frame: false, show: false, backgroundColor: '#ff2040', alwaysOnTop: true })
  await marker.loadURL('data:text/html,<body style="margin:0;background:%23ff2040">')
  const overlays = await prepareScreenshotOverlays()
  const overlay = overlays.find(entry => entry.display.id === display.id)
  if (!overlay) throw new Error('Missing primary display editor')
  await overlay.window.webContents.executeJavaScript('window.screenshotOverlay.onInit(payload => { window.__pixelProbeFrame = payload }); void 0')
  await pause(500)
  let sequence = 0
  async function capture(hide, confirm) {
    const requestId = `pixel-probe-${++sequence}`
    const started = performance.now()
    let readyListener, timeout, rejectReady
    const ready = new Promise((resolve, reject) => {
      rejectReady = reject
      readyListener = (event, id) => { if (id === requestId && event.sender.id === overlay.window.webContents.id) resolve() }
      ipcMain.on('hermes-desktop:screenshot-overlay-ready', readyListener)
      timeout = setTimeout(() => reject(new Error('Probe editor readiness timed out')), 15000)
    })
    const result = captureRegionScreenshot(marker, { requestId, hideWindows: hide, labels }, [marker])
    void result.catch(rejectReady)
    try {
      await ready
      const editorMs = performance.now() - started
      const dataUrl = await overlay.window.webContents.executeJavaScript(`(async () => {
        const payload = window.__pixelProbeFrame;
        const source = document.getElementById('screen');
        const area = ${JSON.stringify(area)}, bounds = ${JSON.stringify(display.bounds)};
        const region = { x: Math.floor(area.x * source.width / bounds.width), y: Math.floor(area.y * source.height / bounds.height), width: Math.floor(area.width * source.width / bounds.width), height: Math.floor(area.height * source.height / bounds.height) };
        const crop = document.createElement('canvas'); crop.width = region.width; crop.height = region.height;
        crop.getContext('2d').drawImage(source, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
        const url = crop.toDataURL('image/png');
        if (${JSON.stringify(confirm)}) {
          const blob = await new Promise(resolve => crop.toBlob(resolve, 'image/png'));
          window.screenshotOverlay.submit({ requestId: payload.requestId, frameId: payload.frameId, region, png: new Uint8Array(await blob.arrayBuffer()) });
        }
        return url;
      })()`)
      const cleanupStarted = performance.now()
      if (!confirm) cancelRegionScreenshot(marker.webContents.id, requestId)
      const exported = await result
      if (confirm && !exported) throw new Error('Probe confirmation did not export a PNG')
      if (!confirm && exported) throw new Error('Probe cancellation unexpectedly exported')
      return { pixels: nativeImage.createFromDataURL(dataUrl).toBitmap(), editorMs, cleanupMs: performance.now() - cleanupStarted }
    } finally {
      clearTimeout(timeout)
      ipcMain.removeListener('hermes-desktop:screenshot-overlay-ready', readyListener)
      cancelRegionScreenshot(marker.webContents.id, requestId)
    }
  }
  const baseline = await capture(false, false)
  const samples = []
  const delays = measureLinuxHide && process.platform === 'linux' ? [50, 100, 200, 350] : [null]
  for (const delay of delays) {
    if (delay === null && !capabilities.hideWindows) continue
    for (let round = 0; round < rounds; round++) {
      marker.show(); marker.focus()
      await pause(200)
      const normal = await capture(false, round % 2 === 0)
      const visible = difference(baseline.pixels, normal.pixels)
      if (visible.fraction < 0.1) throw new Error('Ordinary capture did not include the visible test window')
      await pause(200)
      if (delay !== null) { marker.hide(); await pause(delay) }
      const hidden = await capture(delay === null, round % 2 !== 0)
      const residual = difference(baseline.pixels, hidden.pixels)
      const restored = delay !== null || marker.isVisible()
      samples.push({ round, linuxMeasurementDelayMs: delay, normalEditorMs: normal.editorMs, hiddenEditorMs: hidden.editorMs, cleanupMs: hidden.cleanupMs, residual, restored })
      if (delay === null && !restored) throw new Error('Production hidden mode failed to restore the test window')
      console.log(JSON.stringify(samples.at(-1)))
    }
  }
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
  const gpu = await app.getGPUInfo('basic')
  const report = { timestamp: new Date().toISOString(), platform: process.platform, arch: process.arch, electron: process.versions.electron, environment: { session: process.env.XDG_SESSION_TYPE, desktop: process.env.XDG_CURRENT_DESKTOP, ozone: app.commandLine.getSwitchValue('ozone-platform') }, capabilities, displays: screen.getAllDisplays(), sourceDisplayIds: sources.map(source => source.display_id), gpu, screenPermission: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : undefined, firstEditorMs: baseline.editorMs, samples, passed: samples.length > 0 && samples.every(sample => sample.residual.changedPixels === 0 && sample.restored), measurementOnly: measureLinuxHide }
  if (output) await writeFile(output, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ passed: report.passed, samples: samples.length, output }))
  if (!report.passed) process.exitCode = 1
}

app.whenReady().then(run).catch(error => { console.error(error); process.exitCode = 1 }).finally(() => {
  disposeScreenshotOverlays()
  if (marker && !marker.isDestroyed()) marker.destroy()
  if (background && !background.isDestroyed()) background.destroy()
  app.exit(process.exitCode || 0)
})
