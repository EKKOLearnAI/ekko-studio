#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { windowsBuildArgs } from './windows-build-args.mjs'

const args = windowsBuildArgs(process.argv.slice(2))
const require = createRequire(import.meta.url)
const electronBuilderCli = require.resolve('electron-builder/cli')

function targetsLinux(value) {
  return value === '--linux' || value === 'linux' || value.startsWith('--linux=')
}

function hasConfigOverride(sourceArgs, key) {
  return sourceArgs.some(arg => arg === `--config.${key}` || arg.startsWith(`--config.${key}=`))
}

const debConfigArgs = [
  '--config.productName=hermes-studio',
  '--config.linux.executableName=hermes-studio',
  '--config.linux.desktop.entry.Name=Ekko Studio',
]

function linuxTargetInfo(sourceArgs) {
  const index = sourceArgs.findIndex(targetsLinux)
  if (index < 0) return null

  const flag = sourceArgs[index]
  if (flag.startsWith('--linux=')) {
    return { index, targets: flag.slice('--linux='.length).split(',').filter(Boolean) }
  }

  const targets = []
  for (let i = index + 1; i < sourceArgs.length; i += 1) {
    const arg = sourceArgs[i]
    if (arg.startsWith('-')) break
    targets.push(arg)
  }
  return { index, targets }
}

function withLinuxTargets(sourceArgs, targets) {
  const info = linuxTargetInfo(sourceArgs)
  if (!info) return sourceArgs

  const nextArgs = []
  for (let i = 0; i < sourceArgs.length; i += 1) {
    const arg = sourceArgs[i]
    if (i !== info.index) {
      nextArgs.push(arg)
      continue
    }

    nextArgs.push(arg.startsWith('--linux=') ? '--linux' : arg, ...targets)
    while (i + 1 < sourceArgs.length && !sourceArgs[i + 1].startsWith('-')) {
      i += 1
    }
  }
  return nextArgs
}

function runBuilder(sourceArgs) {
  const result = spawnSync(process.execPath, [electronBuilderCli, ...sourceArgs], { stdio: 'inherit' })
  if (result.error) {
    console.error(result.error.message)
    process.exit(1)
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function withDebConfig(sourceArgs) {
  const finalArgs = [...sourceArgs]
  for (const arg of debConfigArgs) {
    const key = arg.slice('--config.'.length, arg.indexOf('='))
    if (!hasConfigOverride(finalArgs, key)) {
      finalArgs.push(arg)
    }
  }
  return finalArgs
}

const linuxInfo = linuxTargetInfo(args)

if (!linuxInfo) {
  runBuilder(args)
  process.exit(0)
}

const explicitTargets = linuxInfo.targets
const targets = explicitTargets.length > 0 ? explicitTargets : ['AppImage', 'deb']
const hasDeb = targets.includes('deb')
const nonDebTargets = targets.filter(target => target !== 'deb')

if (!hasDeb) {
  runBuilder(args)
  process.exit(0)
}

runBuilder(withDebConfig(withLinuxTargets(args, ['deb'])))

if (nonDebTargets.length > 0) {
  runBuilder(withLinuxTargets(args, nonDebTargets))
}
