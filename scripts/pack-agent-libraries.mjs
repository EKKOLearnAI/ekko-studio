import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Stage only public library artifacts; no workspace links or application sources. */
export function packAgentLibraries(root, output, npmCli = process.env.npm_execpath) {
  if (!npmCli) throw new Error('Run with npm run pack:plugins -- <output-directory>')
  const packages = ['studio-plugin-sdk', 'studio-agent-drivers'].map(directory => {
    const source = join(root, 'packages', directory)
    const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
    for (const file of [manifest.main, manifest.types]) {
      if (!file || !existsSync(join(source, file))) throw new Error(`Build the library first; missing ${directory}/${file}`)
    }
    return { directory, source, manifest }
  })
  const [sdk, driver] = packages
  if (driver.manifest.dependencies?.[sdk.manifest.name] !== sdk.manifest.version) throw new Error('Driver SDK version must match the packed SDK')
  mkdirSync(output, { recursive: true })
  const staging = mkdtempSync(join(tmpdir(), 'studio-agent-libraries-'))
  try {
    return packages.map(({ directory, source, manifest }) => {
      const destination = join(staging, directory)
      mkdirSync(destination)
      cpSync(join(source, 'dist'), join(destination, 'dist'), { recursive: true })
      cpSync(join(root, 'LICENSE'), join(destination, 'LICENSE'))
      writeFileSync(join(destination, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
      const [artifact] = JSON.parse(execFileSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', resolve(output)], {
        cwd: destination, encoding: 'utf8',
      }))
      const files = new Set(artifact.files.map(file => file.path))
      for (const file of ['LICENSE', 'package.json', manifest.main, manifest.types]) {
        if (!files.has(file)) throw new Error(`Missing public library file: ${manifest.name}/${file}`)
      }
      if (artifact.name !== manifest.name || artifact.version !== manifest.version) throw new Error('Packed library identity mismatch')
      return { name: artifact.name, version: artifact.version, filename: artifact.filename, integrity: artifact.integrity, files: artifact.files.length }
    })
  } finally { rmSync(staging, { recursive: true, force: true }) }
}

const script = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === script) {
  const root = resolve(dirname(script), '..')
  console.log(JSON.stringify(packAgentLibraries(root, resolve(process.argv[2] || join(root, 'release/plugins'))), null, 2))
}
