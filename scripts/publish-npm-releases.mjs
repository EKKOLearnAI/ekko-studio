import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packNpmReleases } from './pack-npm-releases.mjs'

const packageNames = ['ekko-studio', 'hermes-web-ui']

export function parsePublishOptions(args) {
  const options = { dryRun: false, help: false, packageName: null, tag: null }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--package' || arg === '--tag') {
      const value = args[++index]
      if (!value || value.startsWith('-')) throw new Error(`Missing value for ${arg}`)
      if (arg === '--package') {
        if (!packageNames.includes(value)) throw new Error(`Unknown package: ${value}`)
        options.packageName = value
      } else {
        if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(value)) throw new Error(`Invalid npm dist-tag: ${value}`)
        options.tag = value
      }
    } else throw new Error(`Unknown option: ${arg}`)
  }
  return options
}

export function publishNpmReleases(rootDir, options, npmCli = process.env.npm_execpath) {
  if (!npmCli) throw new Error('Run this script with npm run publish:npm')
  const metadata = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'))
  if (metadata.name !== 'ekko-studio' || metadata.private) throw new Error('Expected the public ekko-studio source package')
  const tag = options.tag || (metadata.version.includes('-') ? 'next' : 'latest')
  const runNpm = args => execFileSync(process.execPath, [npmCli, ...args], { cwd: rootDir, stdio: 'inherit' })
  runNpm(['run', 'build'])
  const outputDir = join(rootDir, 'release', 'npm')
  const packages = packNpmReleases(rootDir, outputDir, npmCli)
    .filter(pkg => !options.packageName || pkg.name === options.packageName)
  for (const [index, pkg] of packages.entries()) {
    const args = ['publish', join(outputDir, pkg.filename), '--access', 'public', '--tag', tag,
      '--ignore-scripts', '--registry', 'https://registry.npmjs.org']
    if (options.dryRun) {
      console.log(`[dry-run] npm ${args.map(arg => JSON.stringify(arg)).join(' ')}`)
      continue
    }
    console.log(`Publishing ${pkg.name}@${pkg.version} to ${tag}...`)
    try {
      runNpm(args)
    } catch (error) {
      console.error(`Publishing ${pkg.name} failed. After resolving the npm error, retry with:`)
      for (const pending of packages.slice(index)) {
        console.error(`npm run publish:npm -- --package ${pending.name} --tag ${tag}`)
      }
      throw error
    }
  }
  console.log(options.dryRun
    ? 'Dry run complete: built and verified tarballs; no npm publish command was executed.'
    : 'npm publish commands completed. Check npm output for any required publication approval.')
}

const scriptPath = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const options = parsePublishOptions(process.argv.slice(2))
    if (options.help) {
      console.log('Usage: npm run publish:npm -- [--dry-run] [--package ekko-studio|hermes-web-ui] [--tag latest|next|...]')
      console.log('Build once, pack both names, and publish using your local npm login. Does not change the version.')
      console.log('--dry-run builds and packs, then prints publish commands without executing them.')
    } else {
      publishNpmReleases(resolve(dirname(scriptPath), '..'), options)
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
