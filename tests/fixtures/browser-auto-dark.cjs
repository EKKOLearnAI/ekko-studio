const { app, BrowserWindow, WebContentsView } = require('electron')
const { join } = require('node:path')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const output = process.argv[2]
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-gpu')
app.whenReady().then(async () => {
  const { applyBrowserColorScheme } = require(join(__dirname, '../../packages/desktop/dist/main/browser/browser-theme.js'))
  const window = new BrowserWindow({ width: 640, height: 480, show: true })
  const view = new WebContentsView()
  window.contentView.addChildView(view);view.setBounds({ x: 0, y: 0, width: 640, height: 480 })
  await view.webContents.loadURL('data:text/html,'+encodeURIComponent('<body style="margin:0;background:#fff;color:#000"><h1>Fixed white page</h1><div style="height:400px"></div>'))
  const results = []
  for (const scheme of ['light', 'dark', 'light']) {
    await applyBrowserColorScheme(view, scheme)
    await new Promise(r => setTimeout(r, 250))
    const image = await view.webContents.capturePage()
    const bitmap = image.toBitmap();const x=500,y=350;const pos=(y*image.getSize().width+x)*4
    const rgb=[bitmap[pos+2],bitmap[pos+1],bitmap[pos]]
    const dark = await view.webContents.executeJavaScript('matchMedia("(prefers-color-scheme: dark)").matches')
    results.push({ scheme, rgb, prefersDark: dark })
    assert.equal(dark,scheme==='dark')
    assert.equal(rgb.every(v=>v<80),scheme==='dark')
    fs.writeFileSync(join(output,`fixed-white-${results.length}-${scheme}.png`),image.toPNG())
  }
  fs.writeFileSync(join(output,'verification.json'),JSON.stringify({electron:process.versions.electron,results},null,2))
  window.destroy();app.quit()
}).catch(e => { console.error(e); app.exit(1) })
