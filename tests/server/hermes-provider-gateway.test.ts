import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'

it('preserves gateway runtime through the real Python facade, pool and context dispatch', async () => {
  const { stderr } = await promisify(execFile)(process.platform === 'win32' ? 'python' : 'python3', ['-B', resolve('tests/server/fixtures/hermes-provider-gateway.py')], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, timeout: 20_000,
  })
  expect(stderr).toContain('Ran 4 tests')
  expect(stderr).toContain('OK')
})
