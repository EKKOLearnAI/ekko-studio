#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function appendGitHubEnv(name, value) {
  const githubEnv = process.env.GITHUB_ENV
  if (!githubEnv) {
    throw new Error('GITHUB_ENV is required')
  }

  const delimiter = `HERMES_ENV_${randomBytes(12).toString('hex')}`
  appendFileSync(githubEnv, `${name}<<${delimiter}\n${value}\n${delimiter}\n`)
}

function runSecurity(args, { allowFailure = false } = {}) {
  const result = spawnSync('/usr/bin/security', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  if (result.error) {
    throw result.error
  }
  if (result.status !== 0 && !allowFailure) {
    const detail = (result.stderr || result.stdout || '').trim()
    throw new Error(`security ${args[0]} failed${detail ? `: ${detail}` : ''}`)
  }
  return result.stdout || ''
}

function decodeCertificateLink(link) {
  const dataUrlMatch = /^data:[^;]*;base64,/.exec(link)
  if (dataUrlMatch) {
    return Buffer.from(link.slice(dataUrlMatch[0].length), 'base64')
  }
  if (link.startsWith('base64://')) {
    return Buffer.from(link.slice('base64://'.length), 'base64')
  }
  if (link.length > 2048 || link.endsWith('=')) {
    return Buffer.from(link, 'base64')
  }
  return null
}

function resolveCertificatePath(link) {
  if (link.startsWith('file://')) {
    return fileURLToPath(link)
  }
  if (link.startsWith('~/')) {
    return join(homedir(), link.slice(2))
  }
  return isAbsolute(link) ? link : resolve(link)
}

async function writeCertificate(link, destination) {
  const trimmed = link.trim()
  let certificate

  if (trimmed.startsWith('https://')) {
    const response = await fetch(trimmed)
    if (!response.ok) {
      throw new Error(`Unable to download macOS signing certificate: HTTP ${response.status}`)
    }
    certificate = Buffer.from(await response.arrayBuffer())
  } else {
    certificate = decodeCertificateLink(trimmed)
  }

  mkdirSync(dirname(destination), { recursive: true })
  if (certificate) {
    if (certificate.length === 0) {
      throw new Error('Decoded macOS signing certificate is empty')
    }
    writeFileSync(destination, certificate, { mode: 0o600 })
  } else {
    copyFileSync(resolveCertificatePath(trimmed), destination)
    chmodSync(destination, 0o600)
  }
}

function userKeychains() {
  return runSecurity(['list-keychains', '-d', 'user'])
    .split(/\r?\n/)
    .map(line => line.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean)
}

async function configureSigning() {
  const certificateLink = process.env.MAC_CSC_LINK?.trim()
  if (process.argv.includes('--require-signed')) {
    const required = ['MAC_CSC_LINK', 'MAC_APPLE_ID', 'MAC_APPLE_APP_SPECIFIC_PASSWORD', 'MAC_APPLE_TEAM_ID']
    const missing = required.filter(key => !process.env[key]?.trim())
    if (missing.length) {
      throw new Error(`Signed update testing requires signing and notarization secrets: ${missing.join(', ')}`)
    }
  }
  if (!certificateLink) {
    appendGitHubEnv('CSC_IDENTITY_AUTO_DISCOVERY', 'false')
    appendGitHubEnv('MAC_BUILD_EXTRA_ARGS', '--config.mac.notarize=false')
    console.log('No macOS signing certificate configured; building unsigned and skipping notarization.')
    return
  }

  const runnerTemp = process.env.RUNNER_TEMP
  if (!runnerTemp) {
    throw new Error('RUNNER_TEMP is required for macOS signing')
  }

  const certificatePath = join(runnerTemp, 'hermes-signing-certificate.p12')
  const keychainPath = join(runnerTemp, 'hermes-signing.keychain-db')
  const keychainPassword = randomBytes(32).toString('base64')
  const certificatePassword = process.env.MAC_CSC_KEY_PASSWORD || ''

  appendGitHubEnv('CSC_KEYCHAIN', keychainPath)
  await writeCertificate(certificateLink, certificatePath)
  runSecurity(['delete-keychain', keychainPath], { allowFailure: true })
  runSecurity(['create-keychain', '-p', keychainPassword, keychainPath])
  runSecurity(['unlock-keychain', '-p', keychainPassword, keychainPath])
  runSecurity(['set-keychain-settings', '-lut', '21600', keychainPath])

  const existingKeychains = userKeychains()
  if (!existingKeychains.includes(keychainPath)) {
    runSecurity(['list-keychains', '-d', 'user', '-s', keychainPath, ...existingKeychains])
  }

  runSecurity([
    'import',
    certificatePath,
    '-k',
    keychainPath,
    '-T',
    '/usr/bin/codesign',
    '-T',
    '/usr/bin/productbuild',
    '-P',
    certificatePassword,
  ])
  runSecurity([
    'set-key-partition-list',
    '-S',
    'apple-tool:,apple:',
    '-s',
    '-k',
    keychainPassword,
    keychainPath,
  ])

  const appleId = process.env.MAC_APPLE_ID?.trim()
  const appSpecificPassword = process.env.MAC_APPLE_APP_SPECIFIC_PASSWORD?.trim()
  const teamId = process.env.MAC_APPLE_TEAM_ID?.trim()
  if (appleId && appSpecificPassword && teamId) {
    appendGitHubEnv('APPLE_ID', appleId)
    appendGitHubEnv('APPLE_APP_SPECIFIC_PASSWORD', appSpecificPassword)
    appendGitHubEnv('APPLE_TEAM_ID', teamId)
    console.log('macOS signing and notarization are configured with an explicit keychain.')
  } else {
    appendGitHubEnv('MAC_BUILD_EXTRA_ARGS', '--config.mac.notarize=false')
    console.log('macOS signing certificate configured; Apple notarization credentials incomplete, skipping notarization.')
  }
}

function cleanupSigning() {
  const runnerTemp = process.env.RUNNER_TEMP?.trim()
  const keychainPath = process.env.CSC_KEYCHAIN?.trim()
    || (runnerTemp ? join(runnerTemp, 'hermes-signing.keychain-db') : '')
  if (keychainPath && existsSync(keychainPath)) {
    runSecurity(['delete-keychain', keychainPath], { allowFailure: true })
    console.log('Removed temporary macOS signing keychain.')
  }
  if (runnerTemp) {
    rmSync(join(runnerTemp, 'hermes-signing-certificate.p12'), { force: true })
  }
}

async function main() {
  if (process.argv.includes('--cleanup')) {
    cleanupSigning()
    return
  }
  await configureSigning()
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
