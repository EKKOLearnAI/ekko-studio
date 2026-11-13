/* Verify the locked Portal dependency can load inside Electron's asar without optional native modules. */
const { mkdtemp, cp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')
const asar = require('@electron/asar')

async function run() {
  const electron = process.argv.find(value => value.startsWith('--electron='))?.slice('--electron='.length) || require('electron')
  const directory = await mkdtemp(join(tmpdir(), 'studio-screenshot-package-'))
  try {
    const staged = join(directory, 'hermes-studio')
    await cp(join(__dirname, '..', 'package.json'), join(staged, 'package.json'))
    await cp(join(__dirname, '..', 'package-lock.json'), join(staged, 'package-lock.json'))
    const installed = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: staged, stdio: 'inherit', shell: process.platform === 'win32' })
    if (installed.status !== 0) throw new Error('Production dependency install failed')
    const archive = join(directory, 'app.asar')
    await asar.createPackage(staged, archive)
    const files = asar.listPackage(archive)
    if (!files.includes('/node_modules/dbus-next/index.js') || files.some(file => file.endsWith('.node'))) throw new Error('Portal package must contain dbus-next and require no native addon')
    const source = `const dbus = require(${JSON.stringify(archive + '/node_modules/dbus-next')});
      const message = new dbus.Message({ destination: 'org.freedesktop.portal.Desktop', path: '/org/freedesktop/portal/desktop', interface: 'org.freedesktop.portal.Screenshot', member: 'Screenshot', signature: 'sa{sv}', body: ['', { target: new dbus.Variant('u', 4) }] });
      if (message.body[1].target.value !== 4) throw new Error('Invalid packaged D-Bus message');
      console.log(JSON.stringify({ electron: process.versions.electron, arch: process.arch, portalDependency: 'loaded from asar without optional native addons' }));`
    const loaded = spawnSync(electron, ['-e', source], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' })
    if (loaded.status !== 0) throw new Error('Packaged Portal dependency failed to load in Electron')
  } finally { await rm(directory, { recursive: true, force: true }) }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
