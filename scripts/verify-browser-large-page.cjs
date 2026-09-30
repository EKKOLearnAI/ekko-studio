// Offline Electron fixture: no JEV account, remote site or user browser state.
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { createServer } = require('node:http')
const { app, BrowserWindow, dialog } = require('electron')
const { BrowserManager } = require('../packages/desktop/dist/main/browser/browser-manager.js')
const { BrowserBroker } = require('../packages/desktop/dist/main/browser/browser-broker.js')

const root = mkdtempSync(join(tmpdir(), 'studio-large-page-'))
app.setPath('userData', join(root, 'electron'))
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1000, height: 700 })
  const manager = new BrowserManager(window, join(root, 'browser'))
  const broker = new BrowserBroker(manager, join(root, 'broker'))
  const server = createServer()
  let dialogs = 0
  dialog.showMessageBox = async () => { dialogs++; throw new Error('Unexpected action confirmation') }
  try {
    await manager.initialize()
    const descriptor = await broker.start()
    const registration = await fetch(`${descriptor.endpoint}/session`, {
      method: 'POST', headers: { Authorization: `Bearer ${descriptor.token}`, 'Content-Type': 'application/json' }, body: '{}',
    })
    const client = await registration.json()
    const interact = async (tabId, action) => {
      const response = await fetch(descriptor.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${client.session_token}`, 'Content-Type': 'application/json', 'X-Hermes-Browser-Client': client.client_id },
        body: JSON.stringify({ method: 'interact', params: { tab_id: tabId, action } }),
      })
      const body = await response.json()
      assert.equal(response.status, 200, JSON.stringify(body))
      return body.result
    }
    const nav = Array.from({ length: 750 }, (_, i) => `<a href="#item-${i}">Navigation ${i}</a>`).join(' ')
    const html = `<!doctype html><html><body><nav>${nav}</nav>
      <section id="form-demo-layout"><label>Field A<input id="a"></label><label>Field B<input id="b"></label>
      <button id="purchase" onclick="this.dataset.clicked='yes'">APP购买</button>
      <button id="delete" onclick="this.dataset.clicked='yes'">Delete account</button>
      <label>Vertical<input id="vertical" type="radio" name="layout"></label></section>
      <section id="sku"><button onclick="history.pushState({}, '', '?sku=gold'); this.setAttribute('aria-pressed','true')" aria-pressed="false">Gold</button>
      <button onclick="history.replaceState({}, '', '?sku=gold-256'); this.setAttribute('aria-pressed','true')" aria-pressed="false">256 GB</button>
      <button id="add" onclick="this.textContent='Added to cart'">Add to cart</button></section>
      <button id="noop">No effect</button>
      <button id="async" onclick="setTimeout(() => this.textContent='Updated asynchronously', 40)">Update later</button>
      <input id="whitespace" aria-label="Whitespace" oninput="if (this.value) this.value=this.value.trim()+' '">
      <textarea id="multiline" aria-label="Multiline"></textarea>
      <a id="popup" href="/destination" target="_blank">Open destination</a>
      <section id="navigation"><a href="/destination">Navigate away</a><button>Must not click</button></section>
      </body></html>`
    server.on('request', (req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(req.url.startsWith('/destination') ? '<h1>Destination</h1><button>Destination control</button>' : html)
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const tab = await manager.createTab(`http://127.0.0.1:${server.address().port}/`)
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
    assert.equal(result.observation.targets.filter(target => target.valueMatches === true).length, 2)
    const sku = await manager.snapshot(tab.id, { selector: '#sku', interactiveOnly: true })
    const skuBatch = await manager.interactBatch(tab.id, sku.nodes.map(node => ({ action: 'click', ref: node.ref })), sku.snapshotId, () => {})
    assert.equal(skuBatch.completed, 3, JSON.stringify(skuBatch))
    assert.equal(skuBatch.observation.navigation, 'same_document')
    assert.equal(skuBatch.snapshot.nodes.filter(node => node.pressed === true).length, 2)
    assert.ok(skuBatch.observation.changes.some(change => change.after?.name === 'Added to cart'))
    const click = async selector => {
      const snapshot = await manager.snapshot(tab.id, { selector, interactiveOnly: true })
      return interact(tab.id, { action: 'click', ref: snapshot.nodes[0].ref, snapshot_id: snapshot.snapshotId })
    }
    assert.equal((await click('#noop')).observation.changed, false)
    assert.ok((await click('#async')).observation.changes.some(change => change.after?.name === 'Updated asynchronously'))
    for (const [selector, text, value, matches] of [
      ['#whitespace', 'Alice', 'Alice ', false],
      ['#multiline', ' Alice \n Smith ', ' Alice \n Smith ', true],
      ['#multiline', '', '', true],
    ]) {
      const snapshot = await manager.snapshot(tab.id, { selector, interactiveOnly: true })
      const typed = await interact(tab.id, { action: 'type', ref: snapshot.nodes[0].ref, snapshot_id: snapshot.snapshotId, text })
      const target = typed.observation.targets[0]
      if (value === '' && target.after.value === undefined) {
        // Chromium may omit an empty textarea value; absence is not proof of equality.
        assert.equal(target.valueMatches, undefined)
      } else {
        assert.equal(target.after.value, value)
        assert.equal(target.valueMatches, matches)
      }
      assert.equal(await contents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).value`), value)
    }
    const popup = await click('#popup')
    assert.equal(popup.observation.openedTabs.length, 1)
    assert.notEqual(popup.snapshot.tabId, tab.id)
    assert.ok(popup.snapshot.nodes.some(node => node.name === 'Destination'))
    const navigation = await manager.snapshot(tab.id, { selector: '#navigation', interactiveOnly: true })
    const stopped = await manager.interactBatch(tab.id, navigation.nodes.map(node => ({ action: 'click', ref: node.ref })), navigation.snapshotId, () => {})
    assert.equal(stopped.completed, 1, JSON.stringify(stopped))
    assert.equal(stopped.results[1].status, 'failed')
    assert.equal(stopped.observation.navigation, 'new_document')
    assert.ok(stopped.snapshot.nodes.some(node => node.name === 'Destination'))
    console.log(JSON.stringify({ passed: true, totalNodes: first.totalNodes, scopedControls: scoped.nodes.length,
      completed: result.completed, sameDocumentBatch: skuBatch.completed, newDocumentBatch: stopped.completed,
      popupTabId: popup.snapshot.tabId, confirmationDialogs: dialogs, values }))
  } finally {
    await broker.stop()
    server.close()
    await manager.destroy()
    window.destroy()
    rmSync(root, { recursive: true, force: true })
  }
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
