// Offline Electron fixture: no JEV account, remote site or user browser state.
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { app, BrowserWindow, dialog } = require('electron')
const { BrowserManager } = require('../packages/desktop/dist/main/browser/browser-manager.js')

const root = mkdtempSync(join(tmpdir(), 'studio-large-page-'))
app.setPath('userData', join(root, 'electron'))
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1000, height: 700 })
  const manager = new BrowserManager(window, join(root, 'browser'))
  let dialogs = 0
  dialog.showMessageBox = async () => { dialogs++; throw new Error('Unexpected action confirmation') }
  try {
    await manager.initialize()
    const nav = Array.from({ length: 750 }, (_, i) => `<a href="#item-${i}">Navigation ${i}</a>`).join(' ')
    const tab = await manager.createHtmlPreviewTab(`<!doctype html><html><body><nav>${nav}</nav>
      <section id="form-demo-layout"><label>Field A<input id="a"></label><label>Field B<input id="b"></label>
      <button id="purchase" onclick="this.dataset.clicked='yes'">APP购买</button>
      <button id="delete" onclick="this.dataset.clicked='yes'">Delete account</button>
      <label>Vertical<input id="vertical" type="radio" name="layout"></label></section></body></html>`, 'Large page fixture')
    manager.setViewport({ x: 0, y: 0, width: 950, height: 650 }, true)
    const first = await manager.snapshot(tab.id)
    assert.ok(first.totalNodes > 750)
    assert.equal(first.nodes.length, 100)
    assert.equal(first.hasMore, true)
    const second = await manager.snapshot(tab.id, { snapshotId: first.snapshotId, offset: first.nextOffset })
    assert.equal(second.snapshotId, first.snapshotId)
    assert.equal(second.nodes[0].ref, '@e101')
    const searched = await manager.snapshot(tab.id, { query: 'Field A', interactiveOnly: true })
    assert.equal(searched.nodes.length, 1)
    assert.equal(searched.nodes[0].role, 'textbox')
    const scoped = await manager.snapshot(tab.id, { selector: '#form-demo-layout', interactiveOnly: true })
    assert.equal(scoped.nodes.length, 5)
    assert.equal(scoped.hasMore, false)
    const ref = label => {
      const node = scoped.nodes.find(node => node.name.trim() === label)
      assert.ok(node, `Missing control: ${label}`)
      return node.ref
    }
    const result = await manager.interactBatch(tab.id, [
      { action: 'type', ref: ref('Field A'), text: 'Large page A' },
      { action: 'type', ref: ref('Field B'), text: 'Large page B' },
      { action: 'click', ref: ref('APP购买') },
      { action: 'click', ref: ref('Delete account') },
      { action: 'click', ref: ref('Vertical') },
    ], scoped.snapshotId, () => {})
    assert.equal(result.completed, 5, JSON.stringify(result))
    assert.equal(dialogs, 0)
    assert.equal(result.snapshot.nodes.length, 5)
    assert.equal(result.snapshot.scope.selector, '#form-demo-layout')
    assert.equal(result.snapshot.nodes.find(node => node.name.trim() === 'Vertical').checked, true)
    const contents = manager.records.get(tab.id).view.webContents
    const values = await contents.executeJavaScript(`({a:document.getElementById('a').value,b:document.getElementById('b').value,
      purchase:document.getElementById('purchase').dataset.clicked,deleted:document.getElementById('delete').dataset.clicked})`)
    assert.deepEqual(values, { a: 'Large page A', b: 'Large page B', purchase: 'yes', deleted: 'yes' })
    console.log(JSON.stringify({ passed: true, totalNodes: first.totalNodes, scopedControls: scoped.nodes.length,
      completed: result.completed, confirmationDialogs: dialogs, values }))
  } finally {
    await manager.destroy()
    window.destroy()
    rmSync(root, { recursive: true, force: true })
  }
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
