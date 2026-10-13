import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import YAML from 'js-yaml'
import '../../packages/server/src/bootstrap/agent-profile-adapter'
import {
  applyAnthropicOAuthDefaultModel,
  saveAnthropicOAuthTokensForProfile,
  start as anthropicStart,
  status as anthropicStatus,
  submit as anthropicSubmit,
} from '../../packages/server/src/modules/hermes/controllers/anthropic-auth'

let hermesHome = ''
const mockResolveAuthorizedCredentials = vi.hoisted(() => vi.fn())
const mockRefreshCatalogInBackground = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/modules/hermes/services/providers/authorized-provider-credentials', () => ({
  resolveAuthorizedProviderRuntimeCredentials: mockResolveAuthorizedCredentials,
}))

vi.mock('../../packages/server/src/modules/hermes/services/providers/model-catalog-cache', () => ({
  refreshProviderModelCatalogForProfileInBackground: mockRefreshCatalogInBackground,
}))

function writeFile(relativePath: string, content: string) {
  const target = join(hermesHome, relativePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

function readYaml(relativePath: string) {
  return YAML.load(readFileSync(join(hermesHome, relativePath), 'utf-8')) as any
}

function readJson(relativePath: string) {
  return JSON.parse(readFileSync(join(hermesHome, relativePath), 'utf-8'))
}

function readEnv(relativePath: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(join(hermesHome, relativePath), 'utf-8')
      .split(/\r?\n/)
      .filter(line => line.includes('='))
      .map((line) => {
        const separator = line.indexOf('=')
        return [line.slice(0, separator), line.slice(separator + 1)]
      }),
  )
}

function makeCtx(profile: string): any {
  return {
    state: { profile: { name: profile } },
    query: {},
    request: { body: {} },
    get: () => '',
    status: 200,
    body: undefined as unknown,
  }
}

describe('Anthropic OAuth controller', () => {
  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-oauth-provider-'))
    process.env.HERMES_HOME = hermesHome
    mockResolveAuthorizedCredentials.mockReset()
    mockRefreshCatalogInBackground.mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.HERMES_HOME
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
    hermesHome = ''
  })

  it('uses a provider-compatible default model when applying OAuth defaults', () => {
    expect(applyAnthropicOAuthDefaultModel({
      model: { provider: 'deepseek', default: 'deepseek-chat', base_url: 'x', api_key: 'y' },
    }).model).toEqual({ provider: 'claude-oauth', default: 'claude-sonnet-4-6' })
  })

  it('persists OAuth credentials in the request-scoped profile only', async () => {
    mkdirSync(join(hermesHome, 'profiles', 'research'), { recursive: true })
    writeFile('config.yaml', 'model:\n  provider: deepseek\n  default: deepseek-chat\n')
    writeFile('profiles/research/config.yaml', 'model:\n  provider: openrouter\n  default: openrouter-model\n')

    await saveAnthropicOAuthTokensForProfile('research', {
      access_token: 'anthropic-access-token',
      refresh_token: 'anthropic-refresh-token',
      expires_in: 3600,
    })

    expect(existsSync(join(hermesHome, 'auth.json'))).toBe(false)
    const auth = readJson('profiles/research/auth.json')
    expect(auth.providers['claude-oauth'].tokens.access_token).toBe('anthropic-access-token')
    expect(auth.credential_pool['claude-oauth'][0].refresh_token).toBe('anthropic-refresh-token')
    expect(auth.providers.anthropic.tokens.access_token).toBe('anthropic-access-token')
    expect(auth.credential_pool.anthropic[0].refresh_token).toBe('anthropic-refresh-token')
    expect(readJson('profiles/research/.anthropic_oauth.json').accessToken).toBe('anthropic-access-token')
    expect(readEnv('profiles/research/.env')).toEqual({
      ANTHROPIC_TOKEN: 'anthropic-access-token',
    })
    expect(readYaml('config.yaml').model).toEqual({ provider: 'deepseek', default: 'deepseek-chat' })
    expect(readYaml('profiles/research/config.yaml').model).toEqual({ provider: 'claude-oauth', default: 'claude-sonnet-4-6' })

    mockResolveAuthorizedCredentials.mockResolvedValue({
      provider: 'anthropic',
      apiKey: 'anthropic-access-token',
    })
    const ctx = makeCtx('research')
    await anthropicStatus(ctx)
    expect(ctx.body).toMatchObject({ authenticated: true })
    expect(mockResolveAuthorizedCredentials).toHaveBeenCalledWith({
      profile: 'research',
      provider: 'claude-oauth',
    })
  })

  async function startSession(profile: string): Promise<{ sessionId: string; state: string }> {
    const ctx = makeCtx(profile)
    await anthropicStart(ctx)
    const state = new URL(ctx.body.authorization_url).searchParams.get('state') || ''
    return { sessionId: ctx.body.session_id, state }
  }

  function submitCtx(profile: string, sessionId: string, code: string): any {
    return { ...makeCtx(profile), params: { sessionId }, request: { body: { code } } }
  }

  it('refreshes the Claude OAuth model catalog in the background after a successful login', async () => {
    mkdirSync(join(hermesHome, 'profiles', 'research'), { recursive: true })
    writeFile('profiles/research/config.yaml', 'model:\n  provider: openrouter\n  default: openrouter-model\n')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_in: 3600 }),
    }))
    const { sessionId, state } = await startSession('research')

    const ctx = submitCtx('research', sessionId, `auth-code#${state}`)
    await anthropicSubmit(ctx)

    expect(ctx.body).toEqual({ status: 'approved', error: null })
    expect(mockRefreshCatalogInBackground).toHaveBeenCalledTimes(1)
    expect(mockRefreshCatalogInBackground).toHaveBeenCalledWith('research', 'claude-oauth', 'oauth-login')
    expect(readJson('profiles/research/auth.json').providers['claude-oauth'].tokens.access_token).toBe('fresh-access')
  })

  it('does not refresh the catalog when the token exchange fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'bad code' }))
    const { sessionId, state } = await startSession('default')

    const ctx = submitCtx('default', sessionId, `auth-code#${state}`)
    await anthropicSubmit(ctx)

    expect(ctx.status).toBe(502)
    expect(mockRefreshCatalogInBackground).not.toHaveBeenCalled()
  })
})
