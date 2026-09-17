import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parse } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'

const workflow = parse(readFileSync(resolve('.github/workflows/npm-publish.yml'), 'utf8'))
const validation = workflow.jobs.build.steps.find((step: any) => step.id === 'release')
const source = validation.run.split("node <<'NODE'\n")[1].split('\nNODE')[0]
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })))

function validate(version: string, tag: string, prerelease = false, name = 'ekko-studio') {
  const dir = mkdtempSync(join(tmpdir(), 'npm-publish-test-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }))
  const output = join(dir, 'output')
  writeFileSync(output, '')
  const result = spawnSync(process.execPath, ['-e', source], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, RELEASE_TAG: tag, RELEASE_PRERELEASE: String(prerelease), GITHUB_OUTPUT: output },
  })
  return { ...result, output: readFileSync(output, 'utf8') }
}

describe('npm publish release validation', () => {
  it.each(['0.7.23', 'v0.7.23'])('accepts the matching stable tag %s', tag => {
    const result = validate('0.7.23', tag)
    expect(result.status, result.stderr).toBe(0)
    expect(result.output).toBe('dist_tag=latest\nversion=0.7.23\n')
  })

  it('keeps prerelease versions and GitHub prereleases off latest', () => {
    for (const result of [validate('0.7.23-beta.1', 'v0.7.23-beta.1'), validate('0.7.23', 'v0.7.23', true)]) {
      expect(result.status, result.stderr).toBe(0)
      expect(result.output).toMatch(/^dist_tag=next\nversion=0\.7\.23/)
    }
  })

  it.each(['v0.7.22', 'main', ''])('rejects mismatched tag %s', tag => {
    const result = validate('0.7.23', tag)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Release tag must match package version')
    expect(result.output).toBe('')
  })

  it('rejects another package', () => {
    const result = validate('0.7.23', 'v0.7.23', false, 'another-package')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Expected the public ekko-studio source package')
  })
})
