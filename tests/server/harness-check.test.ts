import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

function runNode(script: string, cwd: string): string {
  return execFileSync(process.execPath, [script], { cwd, encoding: 'utf8' })
}

describe('repository harness gates', () => {
  it('passes the single harness entry point required for every PR', () => {
    const output = runNode('scripts/harness-check.mjs', repositoryRoot)

    expect(output).toContain('Harness check passed')
  }, 120_000)

  it('keeps the Ekko public API documentation current', () => {
    const output = runNode('scripts/api-doc-harness.mjs', resolve(repositoryRoot, 'packages/ekko-agent'))

    expect(output).toContain('Ekko public API documentation is current')
  }, 120_000)
})
