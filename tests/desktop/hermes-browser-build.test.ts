import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const directories: string[] = []
const script = resolve('packages/desktop/scripts/prepare-hermes-browser.py')
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

function fixture() {
  const source = mkdtempSync(join(tmpdir(), 'hermes-browser-build-'))
  directories.push(source)
  return source
}

it('refuses an existing payload manifest owned by another installer', () => {
  const source = fixture()
  const original = JSON.stringify({ repo: '.', store: 'user-owned-tools' })
  writeFileSync(join(source, 'manifest.json'), original)
  const result = spawnSync('python3', [script, '--source', source, '--target', 'darwin-arm64'], { encoding: 'utf8' })
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('Refusing to replace an unmanaged payload manifest')
  expect(readFileSync(join(source, 'manifest.json'), 'utf8')).toBe(original)
})

it('does not publish a browser payload when upstream tool acquisition fails', () => {
  const source = fixture()
  mkdirSync(join(source, 'pm'))
  writeFileSync(join(source, 'pm', '__init__.py'), '')
  writeFileSync(join(source, 'pm', 'build_operations.py'), 'def prepare_tools(*args, **kwargs):\n    raise RuntimeError("fixture download failed")\n')
  const result = spawnSync('python3', [script, '--source', source, '--target', 'darwin-arm64'], { encoding: 'utf8' })
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('fixture download failed')
  expect(existsSync(join(source, 'manifest.json'))).toBe(false)
})
