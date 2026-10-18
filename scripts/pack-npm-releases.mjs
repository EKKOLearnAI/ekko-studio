import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Build once, then pack both identities without changing the source manifest.
export function packNpmReleases(rootDir, outputDir, npmCli = process.env.npm_execpath) {
  if (!npmCli) throw new Error('Run this script with npm run pack:npm -- <output-directory>')
  const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'))
  if (pkg.name !== 'ekko-studio' || pkg.private) throw new Error('Expected the public ekko-studio source package')
  const required = ['package.json', 'LICENSE', 'dist/client/index.html', 'dist/server/index.js',
    ...Object.values(pkg.bin).map(path => path.replace(/^\.\//, ''))]
  for (const file of required) {
    if (!existsSync(join(rootDir, file))) throw new Error(`Build the package first; missing ${file}`)
  }
  mkdirSync(outputDir, { recursive: true })
  const stagingRoot = mkdtempSync(join(tmpdir(), 'ekko-npm-releases-'))
  try {
    const packages = []
    for (const name of ['ekko-studio', 'hermes-web-ui']) {
      const staging = join(stagingRoot, name)
      mkdirSync(staging)
      for (const path of ['bin', 'dist', 'README.md', 'LICENSE']) {
        cpSync(join(rootDir, path), join(staging, path), { recursive: true })
      }
      writeFileSync(join(staging, 'package.json'), `${JSON.stringify({ ...pkg, name }, null, 2)}\n`)
      const [packed] = JSON.parse(execFileSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json',
        '--pack-destination', resolve(outputDir)], { cwd: staging, encoding: 'utf8' }))
      const files = new Set(packed.files.map(file => file.path))
      for (const file of required) {
        if (!files.has(file)) throw new Error(`Missing ${name} package file: ${file}`)
      }
      if (packed.name !== name || packed.version !== pkg.version) throw new Error('Packed npm identity mismatch')
      packages.push({ name, version: packed.version, filename: packed.filename, integrity: packed.integrity, files: packed.files.length })
    }
    return packages
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true })
  }
}

const scriptPath = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const rootDir = resolve(dirname(scriptPath), '..')
  console.log(JSON.stringify(packNpmReleases(rootDir, resolve(process.argv[2] || join(rootDir, 'release/npm'))), null, 2))
}
