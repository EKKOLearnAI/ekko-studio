#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { checkServerModuleBoundaries } from './server-module-boundaries.mjs'
import { hasManagedMcpNodeMode } from './managed-mcp-harness.mjs'
import { checkDshModuleBoundaries } from './dsh-module-harness.mjs'
import { checkJevIntegrations } from './jev-harness.mjs'

const root = process.cwd()
const failures = []
failures.push(...await checkDshModuleBoundaries(root))
failures.push(...await checkJevIntegrations(root))

function fail(message) {
  failures.push(message)
}

async function readText(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8')
}

function requireFile(relativePath) {
  if (!existsSync(path.join(root, relativePath))) {
    fail(`Missing required harness file: ${relativePath}`)
  }
}

function requireDir(relativePath) {
  if (!existsSync(path.join(root, relativePath))) {
    fail(`Missing required project directory: ${relativePath}`)
  }
}

for (const file of [
  'AGENTS.md',
  'ARCHITECTURE.md',
  'DEVELOPMENT.md',
  'docs/harness/README.md',
  'docs/harness/validation.md',
  'docs/harness/worktree-runbook.md',
  'docs/harness/pr-review.md',
  'docs/harness/server-module-boundaries.md',
  'docs/harness/jev-integrations.md',
  'scripts/jev-integrations.json',
]) {
  requireFile(file)
}

for (const dir of [
  'packages/client/src',
  'packages/server/src',
  'packages/desktop',
  'packages/desktop/build/icons',
  'tests/client',
  'tests/server',
  'tests/e2e',
  '.github/workflows',
]) {
  requireDir(dir)
}

for (const icon of [
  'packages/desktop/build/icon.png',
  'packages/desktop/build/icon.icns',
  'packages/desktop/build/icon.ico',
  'packages/desktop/build/icons/16x16.png',
  'packages/desktop/build/icons/32x32.png',
  'packages/desktop/build/icons/48x48.png',
  'packages/desktop/build/icons/64x64.png',
  'packages/desktop/build/icons/128x128.png',
  'packages/desktop/build/icons/256x256.png',
  'packages/desktop/build/icons/512x512.png',
]) {
  requireFile(icon)
}

const agents = await readText('AGENTS.md')
const agentLines = agents.trimEnd().split(/\r?\n/)
if (agentLines.length > 120) {
  fail(`AGENTS.md should stay short; found ${agentLines.length} lines, expected <= 120`)
}

for (const requiredLink of [
  'DEVELOPMENT.md',
  'ARCHITECTURE.md',
  'docs/harness/README.md',
  'docs/harness/validation.md',
  'docs/harness/worktree-runbook.md',
  'docs/harness/pr-review.md',
]) {
  if (!agents.includes(requiredLink)) {
    fail(`AGENTS.md must link to ${requiredLink}`)
  }
}

const packageJson = JSON.parse(await readText('package.json'))
for (const scriptName of [
  'harness:check',
  'test',
  'test:coverage',
  'test:e2e',
  'build',
]) {
  if (!packageJson.scripts?.[scriptName]) {
    fail(`package.json is missing script: ${scriptName}`)
  }
}

const architecture = await readText('ARCHITECTURE.md')
for (const phrase of [
  'packages/client/src',
  'packages/server/src',
  'packages/desktop',
  'HERMES_WEB_UI_HOME',
  'fail_on_unmatched_files: true',
]) {
  if (!architecture.includes(phrase)) {
    fail(`ARCHITECTURE.md should document: ${phrase}`)
  }
}

const buildWorkflow = await readText('.github/workflows/build.yml')
if (!buildWorkflow.includes('npm run harness:check')) {
  fail('Build workflow must run npm run harness:check')
}

for (const failure of await checkServerModuleBoundaries(root)) {
  fail(failure)
}

for (const [file, factory] of [
  ['packages/server/src/modules/hermes/services/mcp/studio-autoinject.ts', 'managedConfig'],
  ['packages/server/src/modules/ekko/services/mcp.ts', 'managedMcpServerConfig'],
  ['packages/server/src/modules/coding-agents/services/index.ts', 'hermesMcpServerConfig'],
]) {
  if (!hasManagedMcpNodeMode(await readText(file), factory)) {
    fail(`${file}: ${factory} must inject ELECTRON_RUN_AS_NODE: '1' into every managed MCP env; Electron fallback must not launch the desktop GUI`)
  }
}

const desktopReleaseWorkflow = await readText('.github/workflows/desktop-release.yml')
const desktopManualBuildWorkflow = await readText('.github/workflows/desktop-manual-build.yml')
const desktopMacUpdateManifestWorkflow = await readText('.github/workflows/desktop-mac-update-manifest.yml')
const desktopRuntimeWorkflow = await readText('.github/workflows/desktop-runtime.yml')
const webuiReleaseWorkflow = await readText('.github/workflows/webui-release.yml')
const dockerPublishWorkflow = await readText('.github/workflows/docker-publish.yml')
const electronBuilderConfig = await readText('packages/desktop/electron-builder.yml')
const desktopMacEntitlements = await readText('packages/desktop/build/entitlements.mac.plist')
const desktopMacInheritedEntitlements = await readText('packages/desktop/build/entitlements.mac.inherit.plist')
const desktopPackageJson = await readText('packages/desktop/package.json')
const desktopNodeRuntimeConfig = await readText('packages/desktop/scripts/node-runtime-config.mjs')
const desktopFetchNode = await readText('packages/desktop/scripts/fetch-node.mjs')
const desktopFetchPython = await readText('packages/desktop/scripts/fetch-python.mjs')
const desktopFetchHermes = await readText('packages/desktop/scripts/fetch-hermes.mjs')
const desktopInstallHermes = await readText('packages/desktop/scripts/install-hermes.mjs')
const desktopPackageRuntime = await readText('packages/desktop/scripts/package-runtime.mjs')
const desktopWebuiServer = await readText('packages/desktop/src/main/webui-server.ts')
const desktopMain = await readText('packages/desktop/src/main/index.ts')
const desktopUpdater = await readText('packages/desktop/src/main/updater.ts')
const desktopInstallerScript = await readText('packages/desktop/build/installer.nsh')
const desktopRuntimeManager = await readText('packages/desktop/src/main/runtime-manager.ts')
const desktopPaths = await readText('packages/desktop/src/main/paths.ts')
const desktopRuntimeAssetName = await readText('packages/desktop/scripts/runtime-asset-name.mjs')
if (!desktopReleaseWorkflow.includes('files: ${{ matrix.artifact_files }}')) {
  fail('desktop-release.yml must upload matrix-specific artifact_files')
}

if (desktopReleaseWorkflow.includes('types: [published]')) {
  fail('desktop-release.yml must not run full desktop packaging on every published GitHub Release')
}

if (!desktopReleaseWorkflow.includes('gh release edit "$TAG" --repo "$GITHUB_REPOSITORY" --latest')) {
  fail('desktop-release.yml must mark successful full desktop releases as GitHub latest')
}

for (const [file, text] of [
  ['webui-release.yml', webuiReleaseWorkflow],
  ['docker-publish.yml', dockerPublishWorkflow],
]) {
  if (!text.includes('release:') || !text.includes('types: [published]')) {
    fail(`${file} must keep running on published GitHub Releases`)
  }
  if (!text.includes('gh release edit "$TAG" --repo "$GITHUB_REPOSITORY" --latest=false')) {
    fail(`${file} must keep published GitHub Releases out of latest`)
  }
}

if (!webuiReleaseWorkflow.includes('make_latest: false')) {
  fail('webui-release.yml must not mark release uploads as GitHub latest')
}

if (!electronBuilderConfig.includes('icon: build/icons')) {
  fail('electron-builder.yml must configure the Linux icon set')
}

for (const entitlementFile of ['build/entitlements.mac.plist', 'build/entitlements.mac.inherit.plist']) {
  if (!electronBuilderConfig.includes(entitlementFile)) {
    fail(`electron-builder.yml must configure ${entitlementFile}`)
  }
}

for (const [file, text] of [
  ['entitlements.mac.plist', desktopMacEntitlements],
  ['entitlements.mac.inherit.plist', desktopMacInheritedEntitlements],
]) {
  if (!text.includes('<key>com.apple.security.device.audio-input</key>')) {
    fail(`${file} must allow microphone audio input`)
  }
}

for (const target of ['target_os: darwin', 'target_os: win32', 'target_os: linux']) {
  if (!desktopReleaseWorkflow.includes(target)) {
    fail(`desktop-release.yml is missing matrix target ${target}`)
  }
}

for (const expectedGlob of ['*.dmg', '*.exe', '*.AppImage']) {
  if (!desktopReleaseWorkflow.includes(expectedGlob)) {
    fail(`desktop-release.yml is missing expected artifact glob ${expectedGlob}`)
  }
}

if (!desktopReleaseWorkflow.includes('fail_on_unmatched_files: true')) {
  fail('desktop-release.yml must keep fail_on_unmatched_files: true')
}

function workflowCaseBody(text, caseLabel) {
  const start = text.indexOf(`${caseLabel})`)
  if (start < 0) fail(`desktop-manual-build.yml is missing ${caseLabel} case`)
  const end = text.indexOf(';;', start)
  if (end < 0) fail(`desktop-manual-build.yml ${caseLabel} case is missing terminator`)
  return text.slice(start, end)
}

for (const macCase of ['darwin-arm64', 'darwin-x64']) {
  const body = workflowCaseBody(desktopManualBuildWorkflow, macCase)
  if (body.includes('latest*.yml')) {
    fail(`desktop-manual-build.yml must not publish single-arch macOS update manifests from ${macCase}`)
  }
  for (const glob of ['*.dmg.blockmap', '*.zip.blockmap']) {
    if (!body.includes(glob)) {
      fail(`desktop-manual-build.yml ${macCase} must keep uploading ${glob}`)
    }
  }
}

for (const phrase of [
  'mac-update-manifest:',
  "if: needs.validate.outputs.target_os == 'darwin' && github.event.inputs.release_tag != ''",
  'Both macOS architectures are not available yet; leaving latest-mac.yml unchanged.',
  'gh release upload "$TAG" /tmp/latest-mac.yml',
]) {
  if (!desktopManualBuildWorkflow.includes(phrase)) {
    fail(`desktop-manual-build.yml must include macOS manifest repair behavior: ${phrase}`)
  }
}

if (!desktopMacUpdateManifestWorkflow.includes('Repair macOS Update Manifest')) {
  fail('desktop-mac-update-manifest.yml must provide a manual macOS manifest repair workflow')
}

if (!desktopMacUpdateManifestWorkflow.includes("gh release download \"$TAG\"") || !desktopMacUpdateManifestWorkflow.includes('/tmp/latest-mac.yml')) {
  fail('desktop-mac-update-manifest.yml must generate latest-mac.yml from release assets')
}

if (!desktopMacUpdateManifestWorkflow.includes('gh release upload "$TAG" /tmp/latest-mac.yml')) {
  fail('desktop-mac-update-manifest.yml must upload the merged latest-mac.yml to the release')
}

for (const phrase of [
  'resources/python/${os}-${arch}',
  'resources/node/${os}-${arch}',
  'resources/git/${os}-${arch}',
]) {
  if (electronBuilderConfig.includes(phrase)) {
    fail(`electron-builder.yml must not bundle desktop runtime resource: ${phrase}`)
  }
}

for (const phrase of [
  '"fetch:node"',
  '"fetch:git"',
  '"fetch:hermes"',
  '"prepare:runtime"',
  '"package:runtime"',
  '"runtime:asset-name"',
]) {
  if (!desktopPackageJson.includes(phrase)) {
    fail(`packages/desktop/package.json must support runtime package publishing: ${phrase}`)
  }
}

if (!desktopNodeRuntimeConfig.includes("DEFAULT_DESKTOP_NODE_VERSION = '22.22.0'")) {
  fail('desktop runtime Node.js must stay pinned to the Hermes-compatible 22.22.0 release')
}
if (!desktopNodeRuntimeConfig.includes('HERMES_DESKTOP_NODE_VERSION')) {
  fail('desktop runtime Node.js pin must keep an explicit environment override')
}
if (!desktopFetchNode.includes('desktopNodeVersion()')) {
  fail('fetch-node.mjs must resolve the pinned desktop runtime Node.js version')
}
for (const inheritedVersion of ['process.env.NODE_VERSION', 'process.versions.node']) {
  if (desktopFetchNode.includes(inheritedVersion)) {
    fail(`fetch-node.mjs must not inherit the build runner Node.js version: ${inheritedVersion}`)
  }
}

for (const phrase of [
  'steps.check.outputs.missing',
  'npm --prefix packages/desktop run prepare:runtime',
  'npm --prefix packages/desktop run package:runtime',
]) {
  if (!desktopRuntimeWorkflow.includes(phrase)) {
    fail(`desktop-runtime.yml must build and publish missing runtime package assets: ${phrase}`)
  }
}

if (!desktopRuntimeAssetName.includes('hermes-runtime-hermes-agent-')) {
  fail('runtime asset naming must include hermes-agent version')
}

for (const phrase of [
  'websockets',
  'agent-browser@^0.26.0',
  'HERMES_CHROME_FOR_TESTING_VERSION',
  '149.0.7827.55',
  'pinChromeForTestingBundle',
  'chromeForTestingPlatform',
  'AGENT_BROWSER_HOME',
  'AGENT_BROWSER_EXECUTABLE_PATH',
  'PLAYWRIGHT_BROWSERS_PATH',
  'ms-playwright',
  '--no-config',
  '--require-hashes',
  'editable_mode=compat',
]) {
  if (!desktopInstallHermes.includes(phrase)) {
    fail(`install-hermes.mjs must bundle Hermes browser runtime support: ${phrase}`)
  }
}

for (const phrase of [
  "git', ['fetch', '--depth', '1', 'origin', source.ref]",
  "git', ['rev-parse', 'FETCH_HEAD^{commit}']",
  "git', ['checkout', '-B', 'main', fetchedCommit]",
  'Hermes source commit mismatch',
  "git', ['status', '--porcelain']",
  "resolve(SOURCE_DIR, '.git', 'info', 'exclude')",
  "'/base/'",
]) {
  if (!desktopFetchHermes.includes(phrase)) {
    fail(`fetch-hermes.mjs must retain a clean, updateable source checkout: ${phrase}`)
  }
}

if (desktopPackageJson.includes('"patch:hermes"')) {
  fail('packages/desktop/package.json must not mutate the retained Hermes source checkout')
}

for (const phrase of [
  "resolve(OUT_DIR, '.python-base-staging')",
  "'--relocatable'",
  'configWithPythonHome',
  'bundledBaseHomePath',
  "resolve(OUT_DIR, 'base')",
]) {
  if (!desktopFetchPython.includes(phrase)) {
    fail(`fetch-python.mjs must build a relocatable Windows PEP 405 venv: ${phrase}`)
  }
}

for (const phrase of [
  'schema: 2',
  "installMethod: 'git'",
  "cpSync(PY_DIR, join(stage, 'python')",
  'Relocated Hermes version mismatch',
  "git', ['status', '--porcelain']",
]) {
  if (!desktopPackageRuntime.includes(phrase)) {
    fail(`package-runtime.mjs must publish and relocate-check the Hermes Git source: ${phrase}`)
  }
}

for (const phrase of [
  'bundledAgentBrowserHome',
  'AGENT_BROWSER_HOME',
  'bundledNodeBin',
  'HERMES_AGENT_NODE',
  'HERMES_AGENT_GIT',
  'PLAYWRIGHT_BROWSERS_PATH',
  'ms-playwright',
]) {
  if (!desktopWebuiServer.includes(phrase)) {
    fail(`desktop webui server must expose bundled browser runtime: ${phrase}`)
  }
}

if (desktopWebuiServer.includes('bundledBrowserExecutable()')) {
  fail('desktop webui server must let agent-browser resolve the bundled browser from AGENT_BROWSER_HOME')
}

for (const phrase of [
  'requestSingleInstanceLock(QUIT_EXISTING ? { quit: true } : undefined)',
  'hasQuitRequest(additionalData)',
]) {
  if (!desktopMain.includes(phrase)) {
    fail(`desktop main process must forward --quit to an existing app instance: ${phrase}`)
  }
}

for (const phrase of [
  'HERMES_STUDIO_EXE',
  'Get-CimInstance Win32_Process',
  'CloseMainWindow()',
  'Stop-Process -Id',
]) {
  if (!desktopInstallerScript.includes(phrase)) {
    fail(`desktop installer must close stale Ekko Studio processes by installed executable path: ${phrase}`)
  }
}

for (const phrase of [
  'https://download.ekkolearnai.com/latest',
  'https://github.com/EKKOLearnAI/ekko-studio/releases/latest/download',
  'checkForUpdatesWithFallback()',
]) {
  if (!desktopUpdater.includes(phrase)) {
    fail(`desktop updater must check Cloudflare first and keep GitHub as fallback: ${phrase}`)
  }
}

if (desktopUpdater.includes('fetch(')) {
  fail('desktop updater must not make custom fetch requests to resolve the latest release tag')
}

for (const phrase of [
  'HERMES_DESKTOP_RUNTIME_URL',
  'HERMES_DESKTOP_RUNTIME_BASE_URL',
  'runtime-manifest.json',
  'updateable Hermes source files',
  'repairMovedHermesRuntime',
]) {
  if (!desktopRuntimeManager.includes(phrase)) {
    fail(`desktop runtime manager must support downloadable runtime packages: ${phrase}`)
  }
}

if (!desktopPaths.includes('HERMES_DESKTOP_RUNTIME_DIR')) {
  fail('desktop paths must allow HERMES_DESKTOP_RUNTIME_DIR override')
}

if (failures.length > 0) {
  console.error('Harness check failed:')
  for (const failure of failures) {
    console.error(`- ${failure}`)
  }
  process.exit(1)
}

console.log('Harness check passed')
