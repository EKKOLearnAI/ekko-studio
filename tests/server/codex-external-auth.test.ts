import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  codexExternalAuthDocument,
  writeCodexExternalAuth,
} from '../../packages/server/src/modules/coding-agents/services/codex/external-auth'

const temporaryPaths: string[] = []

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode(payload)}.signature`
}

function accessToken(accountId = 'account-123'): string {
  return jwt({
    exp: 4_102_444_800,
    'https://api.openai.com/auth': {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: 'plus',
    },
  })
}

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('Studio-managed global Codex authorization', () => {
  it('builds the Codex external ChatGPT token schema without persisting a refresh token', () => {
    const token = accessToken()
    expect(codexExternalAuthDocument(token, Date.parse('2026-09-13T15:00:00.000Z'))).toEqual({
      auth_mode: 'chatgptAuthTokens',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: token,
        access_token: token,
        refresh_token: '',
        account_id: 'account-123',
      },
      last_refresh: '2026-09-13T15:00:00.000Z',
    })
  })

  it('rejects an OAuth token that cannot identify its ChatGPT account', () => {
    expect(() => codexExternalAuthDocument(jwt({ exp: 4_102_444_800 })))
      .toThrow('Studio Codex OAuth token has no ChatGPT account id')
  })

  it('atomically replaces auth.json in the active global Codex shadow home', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hermes-global-codex-auth-'))
    temporaryPaths.push(rootDir)

    const token = accessToken('account-shadow')
    await writeCodexExternalAuth(rootDir, token)

    const authPath = join(rootDir, 'auth.json')
    const auth = JSON.parse(readFileSync(authPath, 'utf-8'))
    expect(auth.auth_mode).toBe('chatgptAuthTokens')
    expect(auth.OPENAI_API_KEY).toBeNull()
    expect(auth.tokens).toEqual({
      id_token: token,
      access_token: token,
      refresh_token: '',
      account_id: 'account-shadow',
    })
    expect(statSync(authPath).mode & 0o777).toBe(0o600)
  })
})
