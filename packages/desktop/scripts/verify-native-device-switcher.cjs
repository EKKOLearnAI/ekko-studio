// Exercise the compiled desktop UI with OS pointer input on a Windows runner.
const { spawnSync } = require('node:child_process')
const { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, copyFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const outputDir = process.argv.find(value => value.startsWith('--output-dir='))?.slice('--output-dir='.length)
const root = mkdtempSync(join(tmpdir(), 'studio-native-device-verification-'))
try {
  const bundle = join(root, 'entry.cjs')
  writeFileSync(bundle, `module.exports = {...require(${JSON.stringify(resolve(__dirname, '../dist/main/native-device-switcher.js'))}), ...require(${JSON.stringify(resolve(__dirname, '../dist/main/remote-devices.js'))})}`)
  mkdirSync(join(root, 'preload'))
  copyFileSync(resolve(__dirname, '../dist/preload/native-devices.js'), join(root, 'preload/native-devices.js'))
  const env = { ...process.env, STUDIO_TEST_NATIVE_MOUSE: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(require('electron'), [resolve(__dirname, '../../../tests/fixtures/native-device-switcher.cjs'), root, bundle], { env, stdio: 'inherit', timeout: 90000 })
  const reportFile = join(root, 'result.json')
  const report = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : { error: result.error?.message || `Electron exited ${result.status}` }
  if (outputDir) { mkdirSync(outputDir, { recursive: true });writeFileSync(join(outputDir, `native-devices-${process.platform}.json`), JSON.stringify(report, null, 2) + '\n') }
  console.log(JSON.stringify(report))
  if (result.error || result.status !== 0 || !report.ok || !report.osMouse) process.exitCode = 1
} finally { rmSync(root, { recursive: true, force: true }) }
