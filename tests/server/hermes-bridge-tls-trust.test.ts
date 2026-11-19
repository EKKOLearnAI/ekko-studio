import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'

it('installs Hermes platform TLS trust before the bridge imports agent modules', async () => {
  const { stderr } = await promisify(execFile)(process.platform === 'win32' ? 'python' : 'python3', ['-B', resolve('tests/server/fixtures/hermes-bridge-tls-trust.py')], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, timeout: 20_000,
  })
  expect(stderr).toContain('Ran 4 tests')
  expect(stderr).toContain('OK')
})
