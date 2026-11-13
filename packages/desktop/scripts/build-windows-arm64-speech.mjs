#!/usr/bin/env node
// sherpa-onnx-node 1.13.3 has no win-arm64 npm package. Compile its Node-API
// binding against the matching upstream ARM64 DLLs without changing the JS API.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scripts = dirname(fileURLToPath(import.meta.url))
const root = resolve(scripts, '../../..')
const version = '1.13.3'
const commit = '330609dab49be6ee8b30702918ca7abbbad1286a'
const archiveName = `sherpa-onnx-v${version}-win-arm64-shared-MD-Release.tar.bz2`
const archiveSha256 = '989bd333600e169d8da18ad408c30ca2733934ce7812e37a5b9727c17b28b334'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`)
}

function download(url, file, sha256) {
  run('curl.exe', ['--fail', '--location', '--retry', '3', '--output', file, url])
  if (sha256 && createHash('sha256').update(readFileSync(file)).digest('hex') !== sha256) {
    throw new Error(`SHA-256 mismatch: ${file}`)
  }
}

function extract(file, directory) {
  mkdirSync(directory, { recursive: true })
  run('tar.exe', ['-xf', file, '-C', directory, '--strip-components=1'])
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'arm64') {
    throw new Error('Build the speech binding with native ARM64 Node.js on Windows')
  }
  const installed = JSON.parse(readFileSync(join(root, 'node_modules/sherpa-onnx-node/package.json'), 'utf8'))
  if (installed.version !== version) throw new Error(`Update the pinned ARM64 speech build for sherpa-onnx-node ${installed.version}`)
  const temporary = mkdtempSync(join(tmpdir(), 'ekko-arm64-speech-'))
  const output = join(root, 'node_modules/sherpa-onnx-win-arm64')
  try {
    const libraries = join(temporary, 'libraries')
    const archive = join(temporary, archiveName)
    download(`https://github.com/k2-fsa/sherpa-onnx/releases/download/v${version}/${archiveName}`, archive, archiveSha256)
    extract(archive, libraries)

    const source = join(temporary, 'source')
    const sourceArchive = join(temporary, 'source.tar.gz')
    download(`https://codeload.github.com/k2-fsa/sherpa-onnx/tar.gz/${commit}`, sourceArchive)
    extract(sourceArchive, source)

    const nodeVersion = process.versions.node
    const nodeBase = `https://nodejs.org/dist/v${nodeVersion}`
    const sums = join(temporary, 'SHASUMS256.txt')
    download(`${nodeBase}/SHASUMS256.txt`, sums)
    const checksum = name => {
      const line = readFileSync(sums, 'utf8').split(/\r?\n/).find(value => value.trim().endsWith(` ${name}`))
      if (!line) throw new Error(`Missing Node.js checksum: ${name}`)
      return line.split(/\s+/)[0]
    }
    const headersName = `node-v${nodeVersion}-headers.tar.gz`
    const headersArchive = join(temporary, headersName)
    download(`${nodeBase}/${headersName}`, headersArchive, checksum(headersName))
    const headers = join(temporary, 'headers')
    extract(headersArchive, headers)
    const nodeLibrary = join(temporary, 'node.lib')
    download(`${nodeBase}/win-arm64/node.lib`, nodeLibrary, checksum('win-arm64/node.lib'))

    // Install build-only headers in the disposable directory, never in the
    // staged production tree (npm prune would discard our generated package).
    writeFileSync(join(temporary, 'package.json'), JSON.stringify({ private: true }))
    const npmCli = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
    if (!existsSync(npmCli)) throw new Error('Cannot locate the Node.js npm CLI')
    run(process.execPath, [npmCli, 'install', '--prefix', temporary, '--ignore-scripts', '--no-audit', '--no-fund', 'node-addon-api@8.3.0'])
    const build = join(temporary, 'build')
    // CMake writes these values into generated scripts. Backslashes in Windows
    // paths (notably C:\Users) would otherwise become invalid escape sequences.
    const definitions = Object.entries({
      SHERPA_SOURCE: source, SHERPA_INSTALL: libraries, NODE_HEADERS: headers,
      NODE_LIBRARY: nodeLibrary, NODE_ADDON_API: join(temporary, 'node_modules/node-addon-api'),
    }).map(([name, path]) => `-D${name}:PATH=${path.replaceAll('\\', '/')}`)
    run('cmake', ['-S', join(scripts, 'windows-arm64-speech'), '-B', build, '-A', 'ARM64',
      ...definitions])
    run('cmake', ['--build', build, '--config', 'Release', '--parallel', '2'])

    rmSync(output, { recursive: true, force: true })
    mkdirSync(output, { recursive: true })
    copyFileSync(join(build, 'Release/sherpa-onnx.node'), join(output, 'sherpa-onnx.node'))
    for (const name of readdirSync(join(libraries, 'lib')).filter(name => name.endsWith('.dll'))) {
      copyFileSync(join(libraries, 'lib', name), join(output, name))
    }
    copyFileSync(join(source, 'LICENSE'), join(output, 'LICENSE'))
    writeFileSync(join(output, 'package.json'), JSON.stringify({
      name: 'sherpa-onnx-win-arm64', version, os: ['win32'], cpu: ['arm64'], license: 'Apache-2.0',
      main: 'sherpa-onnx.node', sourceCommit: commit,
    }, null, 2) + '\n')
    run(process.execPath, ['-e', "const assert = require('node:assert/strict'); const sherpa = require('sherpa-onnx-node'); assert.equal(typeof sherpa.OnlineRecognizer, 'function'); assert.equal(typeof sherpa.Vad, 'function'); console.log('ARM64 speech runtime:', sherpa.version)"], { cwd: root })
  } catch (error) {
    rmSync(output, { recursive: true, force: true })
    throw error
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
