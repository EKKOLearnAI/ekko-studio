import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'

it('treats a missing or unreachable worker socket as an unloaded session in status_if_loaded', async () => {
  const { stderr } = await promisify(execFile)(process.platform === 'win32' ? 'python' : 'python3', ['-B', resolve('tests/server/fixtures/hermes-status-if-loaded.py')], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, timeout: 20_000,
  })
  expect(stderr).toContain('Ran 6 tests')
  expect(stderr).toContain('OK')
})
