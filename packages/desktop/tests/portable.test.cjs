'use strict'

const assert = require('node:assert/strict')
const { join, resolve } = require('node:path')
const test = require('node:test')

const {
  PORTABLE_MARKER,
  PORTABLE_ROOT_ENV,
  applyPortableEnv,
  isPortableMode,
  resolvePortableLayout,
} = require('../dist/main/portable.js')

const EXE = resolve('/media/usb/Ekko Studio/Ekko Studio.exe')
const ROOT = resolve('/media/usb/Ekko Studio')

test('portable layout is inactive without the marker file', () => {
  assert.equal(resolvePortableLayout(EXE, () => false), null)
  assert.equal(resolvePortableLayout('', () => true), null)
})

test('portable layout keeps every writable root inside the app directory', () => {
  const layout = resolvePortableLayout(EXE, path => path === join(ROOT, PORTABLE_MARKER))
  assert.ok(layout)
  assert.equal(layout.root, ROOT)
  assert.equal(layout.dataRoot, join(ROOT, 'ekko-data'))
  assert.equal(layout.webUiHome, join(ROOT, 'ekko-data', 'studio'))
  assert.equal(layout.hermesHome, join(ROOT, 'ekko-data', 'hermes'))
  assert.equal(layout.userData, join(ROOT, 'ekko-data', 'electron'))
})

test('applying portable env redirects all three relocated roots and flags the mode', () => {
  const layout = resolvePortableLayout(EXE, path => path === join(ROOT, PORTABLE_MARKER))
  assert.ok(layout)

  const env = {}
  assert.equal(isPortableMode(env), false)
  applyPortableEnv(layout, env)

  assert.equal(env[PORTABLE_ROOT_ENV], ROOT)
  assert.equal(env.HERMES_WEB_UI_HOME, layout.webUiHome)
  assert.equal(env.HERMES_WEBUI_STATE_DIR, layout.webUiHome)
  assert.equal(env.HERMES_HOME, layout.hermesHome)
  // The runtime must stay under webUiHome, or the app records a validation
  // failure for the stranded root and lists it as an extra version.
  assert.equal(env.HERMES_DESKTOP_RUNTIME_DIR, undefined)
  assert.equal(isPortableMode(env), true)
})
