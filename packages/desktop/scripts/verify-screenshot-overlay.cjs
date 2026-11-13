/* Electron checks the production overlay against the operating system's monitor. */
const { spawnSync, execFileSync } = require('node:child_process')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const option = (name, fallback) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback
const outputDir = option('output-dir', '')

if (!process.versions.electron) {
  const electron = option('electron', '') || require('electron')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(electron, [__filename, `--output-dir=${outputDir}`], { env, stdio: 'inherit', timeout: 60_000 })
  if (result.error || result.status !== 0) {
    console.error(result.error || `Overlay coverage failed: ${result.status}`)
    process.exit(1)
  }
} else {
  const { app, screen } = require('electron')
  const { release } = require('node:os')
  const { prepareScreenshotOverlays, disposeScreenshotOverlays } = require('../dist/main/screenshot-windows')
  const report = { timestamp: new Date().toISOString(), platform: process.platform, osRelease: release(), arch: process.arch, electron: process.versions.electron, forcedScale: app.commandLine.getSwitchValue('force-device-scale-factor'), displays: [], samples: [], passed: false }
  const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

  function assertRect(actual, expected, name) {
    // At fractional DPI, DIP/integer physical conversions can round by one pixel.
    const edges = rect => [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height]
    if (edges(actual).some((value, index) => Math.abs(value - edges(expected)[index]) > 1)) {
      throw new Error(`${name}: ${JSON.stringify(actual)} does not match ${JSON.stringify(expected)}`)
    }
  }

  function nativeWindowGeometry(window) {
    const handle = window.getNativeWindowHandle().readBigUInt64LE().toString()
    const script = `
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class OverlayClient {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int Size; public RECT Monitor, Work; public uint Flags; }
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll", SetLastError=true)] static extern bool GetClientRect(IntPtr window, out RECT rect);
  [DllImport("user32.dll", SetLastError=true)] static extern bool ClientToScreen(IntPtr window, ref POINT point);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
  [DllImport("user32.dll", SetLastError=true)] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  public static int[] Read(long handle) {
    var previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
    try {
      var window = new IntPtr(handle); RECT rect; var origin = new POINT();
      if (!GetClientRect(window, out rect) || !ClientToScreen(window, ref origin)) throw new Win32Exception();
      var info = new MONITORINFO(); info.Size = Marshal.SizeOf(typeof(MONITORINFO));
      if (!GetMonitorInfo(MonitorFromWindow(window, 2), ref info)) throw new Win32Exception();
      return new int[] { origin.X, origin.Y, rect.Right - rect.Left, rect.Bottom - rect.Top,
        info.Monitor.Left, info.Monitor.Top, info.Monitor.Right - info.Monitor.Left, info.Monitor.Bottom - info.Monitor.Top };
    } finally { if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
  }
}
'@
$value = [OverlayClient]::Read(${handle})
@{ client=@{ x=$value[0]; y=$value[1]; width=$value[2]; height=$value[3] };
   monitor=@{ x=$value[4]; y=$value[5]; width=$value[6]; height=$value[7] } } | ConvertTo-Json -Compress
`
    return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 15_000 }).trim())
  }

  app.whenReady().then(async () => {
    report.displays = screen.getAllDisplays()
    if (process.platform === 'win32' && report.forcedScale) throw new Error('Use actual Windows Display Settings DPI: force-device-scale-factor can double-scale Electron display bounds (electron/electron#26344)')
    if (!report.displays.length) throw new Error('Native overlay coverage requires an attached desktop display')
    // Cover first-show and warmed reuse. Work area intentionally differs from full bounds.
    for (let round = 0; round < 2; round++) {
      const entries = await prepareScreenshotOverlays(report.displays)
      for (const entry of entries) entry.window.showInactive()
      await pause(200)
      for (const { window, display } of entries) {
        const sample = { round, displayId: display.id, expected: display.bounds, windowBounds: window.getBounds(), contentBounds: window.getContentBounds() }
        report.samples.push(sample)
        assertRect(sample.windowBounds, display.bounds, 'Window DIP edges')
        assertRect(sample.contentBounds, display.bounds, 'Content DIP edges')
        sample.renderer = await window.webContents.executeJavaScript(`({ width: innerWidth, height: innerHeight, devicePixelRatio, stage: (() => { const rect = document.getElementById('stage').getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })() })`)
        assertRect({ x: 0, y: 0, width: sample.renderer.width, height: sample.renderer.height }, { x: 0, y: 0, width: display.bounds.width, height: display.bounds.height }, 'Renderer viewport')
        assertRect(sample.renderer.stage, { x: 0, y: 0, width: display.bounds.width, height: display.bounds.height }, 'Screenshot stage')
        if (process.platform === 'win32') {
          sample.expectedPhysical = screen.dipToScreenRect(window, display.bounds)
          const native = nativeWindowGeometry(window)
          sample.nativeClient = native.client
          sample.nativeMonitor = native.monitor
          assertRect(sample.nativeClient, sample.expectedPhysical, 'Native Win32 client edges')
          assertRect(sample.nativeClient, sample.nativeMonitor, 'Full physical monitor coverage')
        }
        window.hide()
      }
    }
    report.passed = true
  }).catch(error => {
    report.error = String(error.stack || error)
    process.exitCode = 1
  }).finally(() => {
    disposeScreenshotOverlays()
    if (outputDir) {
      mkdirSync(outputDir, { recursive: true })
      writeFileSync(join(outputDir, `overlay-${report.platform}-${report.forcedScale || 'default'}.json`), JSON.stringify(report, null, 2) + '\n')
    }
    console.log(JSON.stringify(report))
    app.exit(process.exitCode || 0)
  })
}
