import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parse, stringify } from 'yaml'
import { replaceHermesApiKeyDomains } from '../../packages/server/src/modules/hermes/services/profiles/apikey-domain-replacement'
import { getStartupTasks } from '../../packages/server/src/bootstrap/startup-tasks'
import { runStartupTasks } from '../../packages/server/src/modules/studio/services/startup-tasks'

let hermesHome: string

vi.mock('../../packages/server/src/modules/hermes/services/profiles/profile', () => ({
  getHermesBaseDir: () => hermesHome,
  getProfileDir: (profile: string) => profile === 'default' ? hermesHome : join(hermesHome, 'profiles', profile),
  listProfileNamesFromDisk: () => ['default', 'research', 'empty'],
}))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }))

function configPath(profile = 'default') {
  return join(profile === 'default' ? hermesHome : join(hermesHome, 'profiles', profile), 'config.yaml')
}

beforeEach(() => {
  hermesHome = mkdtempSync(join(tmpdir(), 'hermes-apikey-domain-'))
  mkdirSync(join(hermesHome, 'profiles', 'research'), { recursive: true })
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(hermesHome, { recursive: true, force: true })
})

describe('Hermes startup apikey domain replacement', () => {
  it('records completion only after every profile succeeds, then skips future startups', async () => {
    const stateFile = join(hermesHome, 'studio-state', 'startup-tasks.json')
    writeFileSync(configPath(), 'providers: [invalid yaml')
    writeFileSync(configPath('research'), 'model:\n  base_url: https://api.apikey.fun/v1\n')
    const tasks = getStartupTasks()
    expect(tasks).toHaveLength(1)
    expect((await runStartupTasks(tasks, stateFile)).failed).toEqual([tasks[0].id])
    writeFileSync(configPath(), 'model:\n  base_url: https://api.apikey.fun/v1\n')
    expect((await runStartupTasks(getStartupTasks(), stateFile)).completed).toEqual([tasks[0].id])
    expect(readFileSync(configPath(), 'utf8')).toContain('https://api.apikey.fan/v1')
    const original = 'model:\n  base_url: https://api.apikey.fun/v1\n'
    writeFileSync(configPath(), original)
    expect((await runStartupTasks(getStartupTasks(), stateFile)).skipped).toEqual([tasks[0].id])
    expect(readFileSync(configPath(), 'utf8')).toBe(original)
  })

  it('updates both provider formats and model routes across profiles, retaining settings and backups', async () => {
    const original = '# My providers\n' + stringify({
      model: { provider: 'custom:fun-codex', default: 'gpt-5.5', base_url: 'https://api.apikey.fun/v1' },
      custom_providers: [{ name: 'fun-codex', base_url: 'https://api.apikey.fun:8443/v1/?route=apikey.fun#section', api_key: 'secret-apikey.fun', model: 'gpt-5.5' }],
      auxiliary: { image_generation: { base_url: 'https://api.apikey.fun/v1' } },
      fallbacks: [{ base_url: 'https://apikey.fun/v1' }],
      notes: 'https://apikey.fun',
    })
    writeFileSync(configPath(), original)
    writeFileSync(configPath('research'), stringify({ providers: {
      'fun-claude': { url: 'https://api.apikey.fun', api_key: 'test-key', api_mode: 'anthropic_messages' },
      other: { api: 'https://apikey.fun/v1' },
      camel: { baseUrl: 'api.apikey.fun/v1' },
      backup: { base_url: 'https://slb.apikey.fan/v1' },
    } }))

    expect(await replaceHermesApiKeyDomains()).toEqual({ updatedProfiles: ['default', 'research'], failedProfiles: [] })
    const updated = parse(readFileSync(configPath(), 'utf8'))
    expect(updated.model).toEqual({ provider: 'custom:fun-codex', default: 'gpt-5.5', base_url: 'https://api.apikey.fan/v1' })
    expect(updated.custom_providers[0]).toEqual({ name: 'fun-codex', base_url: 'https://api.apikey.fan:8443/v1/?route=apikey.fun#section', api_key: 'secret-apikey.fun', model: 'gpt-5.5' })
    expect(updated.auxiliary.image_generation.base_url).toBe('https://api.apikey.fan/v1')
    expect(updated.fallbacks[0].base_url).toBe('https://apikey.fan/v1')
    expect(updated.notes).toBe('https://apikey.fun')
    expect(readFileSync(configPath(), 'utf8')).toContain('# My providers')
    expect(readFileSync(`${configPath()}.bak`, 'utf8')).toBe(original)
    const providers = parse(readFileSync(configPath('research'), 'utf8')).providers
    expect(providers['fun-claude']).toEqual({ url: 'https://api.apikey.fan', api_key: 'test-key', api_mode: 'anthropic_messages' })
    expect(providers.other.api).toBe('https://apikey.fan/v1')
    expect(providers.camel.baseUrl).toBe('api.apikey.fan/v1')
    expect(providers.backup.base_url).toBe('https://slb.apikey.fan/v1')

    const before = statSync(configPath()).mtimeMs
    expect(await replaceHermesApiKeyDomains()).toEqual({ updatedProfiles: [], failedProfiles: [] })
    expect(statSync(configPath()).mtimeMs).toBe(before)
    expect(readFileSync(`${configPath()}.bak`, 'utf8')).toBe(original)
    expect(existsSync(configPath('empty'))).toBe(false)
  })

  it.each([
    'https://api.apikey.fan/v1',
    'https://slb.apikey.fan/v1',
    'https://api.apikey.fun.example.com/v1',
    'https://example.com/api.apikey.fun/v1',
    'https://api.apikey.fun:password@example.com/v1',
    'https://custom.apikey.fun/v1',
    'ftp://api.apikey.fun/v1',
    '${CUSTOM_BASE_URL}',
  ])('does not rewrite an unrelated or already updated URL: %s', async base_url => {
    const raw = stringify({ custom_providers: [{ name: 'custom', base_url }] })
    writeFileSync(configPath(), raw)
    expect((await replaceHermesApiKeyDomains()).updatedProfiles).toEqual([])
    expect(readFileSync(configPath(), 'utf8')).toBe(raw)
    expect(existsSync(`${configPath()}.bak`)).toBe(false)
  })

  it('replaces only endpoint environment values while preserving quoting, comments and credentials', async () => {
    const envPath = join(hermesHome, '.env')
    const raw = [
      '# https://api.apikey.fun',
      'OPENAI_BASE_URL="https://api.apikey.fun/v1" # custom',
      "export ANTHROPIC_BASE_URL='https://apikey.fun'",
      'OTHER_BASE_URL=https://api.apikey.fun:8443/v1/?x=1',
      'BACKUP_BASE_URL=https://slb.apikey.fan/v1',
      'OPENAI_API_KEY=https://api.apikey.fun',
      '',
    ].join('\r\n')
    writeFileSync(envPath, raw)
    expect((await replaceHermesApiKeyDomains()).updatedProfiles).toEqual(['default'])
    expect(readFileSync(envPath, 'utf8')).toBe(raw
      .replace('"https://api.apikey.fun/v1"', '"https://api.apikey.fan/v1"')
      .replace("'https://apikey.fun'", "'https://apikey.fan'")
      .replace('https://api.apikey.fun:8443', 'https://api.apikey.fan:8443'))
    expect(readFileSync(`${envPath}.bak`, 'utf8')).toBe(raw)
    expect(existsSync(configPath())).toBe(false)
  })

  it('still replaces an endpoint that follows an empty *_BASE_URL assignment', async () => {
    const envPath = join(hermesHome, '.env')
    const raw = ['KIMI_BASE_URL=', 'ANTHROPIC_BASE_URL=https://api.apikey.fun/v1', ''].join('\n')
    writeFileSync(envPath, raw)
    expect((await replaceHermesApiKeyDomains()).updatedProfiles).toEqual(['default'])
    expect(readFileSync(envPath, 'utf8')).toBe(raw.replace('api.apikey.fun', 'api.apikey.fan'))
  })

  it('leaves malformed config intact, continues other profiles, and retries after repair', async () => {
    const malformed = 'providers: [invalid yaml'
    writeFileSync(configPath(), malformed)
    writeFileSync(configPath('research'), 'model:\n  base_url: https://api.apikey.fun/v1\n')
    expect(await replaceHermesApiKeyDomains()).toEqual({ updatedProfiles: ['research'], failedProfiles: ['default'] })
    expect(readFileSync(configPath(), 'utf8')).toBe(malformed)
    writeFileSync(configPath(), 'model:\n  base_url: https://api.apikey.fun/v1\n')
    expect(await replaceHermesApiKeyDomains()).toEqual({ updatedProfiles: ['default'], failedProfiles: [] })
  })
})
