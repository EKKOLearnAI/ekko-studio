import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { describe, it } from 'vitest'

describe('Hermes bridge title API compatibility', () => {
  it('supports legacy/current title APIs without duplicate calls or credential leaks', () => {
    try {
      execFileSync('python3', ['-B', fileURLToPath(new URL('./agent-bridge-title-compat.test.py', import.meta.url))], {
        encoding: 'utf-8', stdio: 'pipe',
      })
    } catch (error) {
      const failure = error as { message?: string; stdout?: string; stderr?: string }
      throw new Error([failure.message, failure.stdout, failure.stderr].filter(Boolean).join('\n'))
    }
  })
})
