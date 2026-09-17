import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildSync } from 'esbuild'
import { packNpmReleases } from '../../scripts/pack-npm-releases.mjs'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })))

describe('dual npm release artifacts', () => {
  it('packs both identities, preserves the source and runs the new bin with its own identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'studio-dual-pack-test-'))
    dirs.push(root)
    const metadata = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
    metadata.version = '99.0.0-test.1'
    const manifest = `${JSON.stringify(metadata, null, 2)}\n`
    writeFileSync(join(root, 'package.json'), manifest)
    cpSync(resolve('bin'), join(root, 'bin'), { recursive: true })
    for (const file of ['README.md', 'LICENSE']) cpSync(resolve(file), join(root, file))
    mkdirSync(join(root, 'dist/client'), { recursive: true })
    mkdirSync(join(root, 'dist/server'), { recursive: true })
    writeFileSync(join(root, 'dist/client/index.html'), '<html>same client</html>')
    writeFileSync(join(root, 'dist/server/index.js'), '/* same server */')
    const output = join(root, 'output')
    const packed = packNpmReleases(root, output)
    expect(packed.map(pkg => pkg.name)).toEqual(['ekko-studio', 'hermes-web-ui'])
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(manifest)

    for (const artifact of packed) {
      const unpacked = join(root, artifact.name)
      mkdirSync(unpacked)
      execFileSync('tar', ['-xzf', join(output, artifact.filename), '-C', unpacked])
      const packageDir = join(unpacked, 'package')
      const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
      expect(pkg.name).toBe(artifact.name)
      expect(pkg.version).toBe('99.0.0-test.1')
      expect(pkg.bin['ekko-studio-web']).toBeTruthy()
      expect(pkg.bin['hermes-web-ui']).toBeTruthy()
      expect(readFileSync(join(packageDir, 'dist/server/index.js'), 'utf8')).toBe('/* same server */')
      const version = execFileSync(process.execPath, [resolve(packageDir, pkg.bin['ekko-studio-web']), '--version'], {
        cwd: root, encoding: 'utf8',
      })
      expect(version.trim()).toBe(`${pkg.name === 'ekko-studio' ? 'ekko-studio-web' : 'hermes-web-ui'} v99.0.0-test.1`)
      // Exercise the same __dirname layout as the bundled production server,
      // while cwd still points to the canonical ekko-studio source fixture.
      const identityProbe = join(packageDir, 'dist/server/package-identity.cjs')
      buildSync({
        entryPoints: [resolve('packages/server/src/modules/studio/services/package-info.ts')],
        bundle: true, platform: 'node', format: 'cjs', outfile: identityProbe,
        footer: { js: 'console.log(module.exports.readStudioPackageInfo().name)' },
      })
      expect(execFileSync(process.execPath, [identityProbe], { cwd: root, encoding: 'utf8' }).trim()).toBe(pkg.name)
    }
  }, 30_000)

  it('rejects an unbuilt source before producing release artifacts', () => {
    const root = mkdtempSync(join(tmpdir(), 'studio-unbuilt-pack-test-'))
    dirs.push(root)
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ekko-studio', version: '1.0.0', bin: {} }))
    expect(() => packNpmReleases(root, join(root, 'output'))).toThrow('Build the package first')
  })
})
