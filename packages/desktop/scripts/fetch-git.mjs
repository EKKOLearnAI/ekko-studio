#!/usr/bin/env node
// Download Git for Windows MinGit for Windows builds. Other platforms create
// an empty resource directory so electron-builder can use the same resource map.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { arch as osArch, platform as osPlatform, tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const TARGET_OS = process.env.TARGET_OS || osPlatform()
const TARGET_ARCH = process.env.TARGET_ARCH || osArch()
const OS_LABEL = TARGET_OS === 'win32' ? 'win' : TARGET_OS === 'darwin' ? 'mac' : TARGET_OS
const OUT_DIR = resolve(ROOT, 'resources', 'git', `${OS_LABEL}-${TARGET_ARCH}`)

mkdirSync(OUT_DIR, { recursive: true })

if (TARGET_OS !== 'win32') {
  writeFileSync(resolve(OUT_DIR, '.placeholder'), 'Git for Windows is only bundled on Windows.\n')
  console.log(`Git resource placeholder ready at ${OUT_DIR}`)
  process.exit(0)
}

if (!['x64', 'arm64'].includes(TARGET_ARCH)) {
  console.error(`Unsupported Git for Windows target: ${TARGET_OS}-${TARGET_ARCH}`)
  process.exit(1)
}

if (existsSync(resolve(OUT_DIR, 'cmd', 'git.exe'))) {
  console.log(`Git for Windows already present at ${OUT_DIR}, skipping`)
  process.exit(0)
}

async function latestMinGitUrl() {
  if (process.env.GIT_FOR_WINDOWS_URL?.trim()) return process.env.GIT_FOR_WINDOWS_URL.trim()

  const headers = { 'User-Agent': 'hermes-studio-desktop-build' }
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`

  const response = await fetch('https://api.github.com/repos/git-for-windows/git/releases/latest', {
    headers,
  })
  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status}`)
  }
  const release = await response.json()
  const assetPattern = TARGET_ARCH === 'arm64' ? /^MinGit-[\d.]+-arm64\.zip$/ : /^MinGit-[\d.]+-64-bit\.zip$/
  const asset = release.assets?.find(candidate =>
    typeof candidate?.name === 'string'
    && assetPattern.test(candidate.name)
    && typeof candidate.browser_download_url === 'string',
  )
  if (!asset) throw new Error(`Could not find MinGit ${TARGET_ARCH} zip in latest Git for Windows release`)
  return asset.browser_download_url
}

let url
try {
  url = await latestMinGitUrl()
} catch (err) {
  console.error(`Failed to resolve Git for Windows download URL: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

const file = url.split('/').pop() || 'mingit.zip'
const archivePath = resolve(tmpdir(), file)

console.log(`Fetching ${url}`)
const curl = spawnSync('curl', ['-fL', '--retry', '3', '-o', archivePath, url], { stdio: 'inherit' })
if (curl.status !== 0) {
  console.error('curl failed')
  process.exit(curl.status ?? 1)
}

console.log(`Extracting into ${OUT_DIR}`)
const extract = spawnSync('tar', ['-xf', archivePath, '-C', OUT_DIR], { stdio: 'inherit' })
if (extract.status !== 0) {
  console.error('extract failed')
  process.exit(extract.status ?? 1)
}

rmSync(archivePath, { force: true })
console.log(`Git for Windows ready at ${OUT_DIR}`)
