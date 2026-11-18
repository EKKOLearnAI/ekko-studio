import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../packages/server/src/modules/studio/public/profile-config', async () => {
  const cfg = await import('../../packages/server/src/modules/hermes/services/profiles/config')
  return {
    updateConfigYamlForProfile: cfg.updateConfigYamlForProfile,
    saveEnvValueForProfile: cfg.saveEnvValueForProfile,
    PROVIDER_ENV_MAP: {},
  }
})

vi.mock('../../packages/server/src/modules/studio/public/provider-runtime', () => ({
  invalidateProviderRuntime: vi.fn(() => ({ invalidatedRuns: 0, deferredRuns: 0 })),
}))

let home = ''
const previousHome = process.env.HERMES_HOME

function writeProfile(configYaml: string, envText: string): void {
  writeFileSync(join(home, 'config.yaml'), configYaml, 'utf-8')
  writeFileSync(join(home, '.env'), envText, 'utf-8')
}

async function putProvider(poolKey: string, body: Record<string, unknown>) {
  const { update } = await import('../../packages/server/src/modules/hermes/controllers/providers')
  const ctx: any = { params: { poolKey }, request: { body }, state: { profile: { name: 'default' } }, query: {} }
  await update(ctx)
  return ctx
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ekko-key-env-'))
  process.env.HERMES_HOME = home
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

it('writes a saved API key to the env var named by key_env', async () => {
  writeProfile(
    [
      'custom_providers:',
      '  - name: keytest',
      '    base_url: http://127.0.0.1:8999/v1',
      '    key_env: EKKO_KEYTEST_API_KEY',
      '    api_key: inline-key-BBB',
      '    model: mock-model-1',
      '',
    ].join('\n'),
    'EKKO_KEYTEST_API_KEY=env-key-AAA\nOTHER_VAR=keep-me\n',
  )

  const ctx = await putProvider('custom:keytest', { api_key: 'settings-key-CCC' })

  expect(ctx.status).not.toBe(500)
  expect(ctx.body).toEqual({ success: true })
  const env = readFileSync(join(home, '.env'), 'utf-8')
  expect(env).toContain('EKKO_KEYTEST_API_KEY=settings-key-CCC')
  expect(env).not.toContain('env-key-AAA')
  expect(env).toContain('OTHER_VAR=keep-me')
  expect(readFileSync(join(home, 'config.yaml'), 'utf-8')).toContain('api_key: settings-key-CCC')
})

it('keeps writing the inline api_key for providers without key_env', async () => {
  writeProfile(
    [
      'custom_providers:',
      '  - name: plain',
      '    base_url: http://127.0.0.1:8999/v1',
      '    api_key: inline-old',
      '    model: mock-model-1',
      '',
    ].join('\n'),
    'UNRELATED=1\n',
  )

  const ctx = await putProvider('custom:plain', { api_key: 'inline-new' })

  expect(ctx.body).toEqual({ success: true })
  expect(readFileSync(join(home, 'config.yaml'), 'utf-8')).toContain('api_key: inline-new')
  expect(readFileSync(join(home, '.env'), 'utf-8')).toBe('UNRELATED=1\n')
})
