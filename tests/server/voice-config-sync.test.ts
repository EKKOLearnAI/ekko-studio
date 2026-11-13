import type { Context } from 'koa'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

let root: string
let db: DatabaseSync
const runtime = vi.hoisted(() => ({ port: 18647, localUsable: true }))
vi.mock('../../packages/server/src/modules/studio/infrastructure/database', () => ({ getDb: () => db }))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({
  config: { get appHome() { return root }, get port() { return runtime.port } },
}))
vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({ getToken: async () => 'synthetic-loopback-token' }))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: { warn: vi.fn() } }))
vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  updateConfigYamlForProfile: (profile: string, updater: Parameters<typeof safeFileStore.updateYaml>[1]) =>
    safeFileStore.updateYaml(profilePath(profile), updater, { backup: true }),
}))
vi.mock('../../packages/server/src/modules/studio/services/voice/stt/local-model-manager', () => ({
  isLocalSttModelUsable: () => runtime.localUsable,
  getLocalSttModelStatus: () => ({ usable: runtime.localUsable }),
  LOCAL_STT_MODEL_ID: 'synthetic-local-model',
}))
// Settings controllers use the real repositories and sync service; speech/run
// boundaries are unused here and must not load audio models or application state.
vi.mock('../../packages/server/src/modules/studio/services/session-shares/access', () => ({}))
vi.mock('../../packages/server/src/modules/studio/public/mcu-voice', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/global-agent/mcu-agent-runtime', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/voice/mcu/prompts', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/voice/stt', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/voice/stt/audio-convert', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/voice/tts/core', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/voice/tts/providers', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/voice/tts/providers/url-safety', () => ({}))

import * as schemas from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import * as settings from '../../packages/server/src/modules/studio/public/voice-settings'
import { safeFileStore } from '../../packages/server/src/modules/studio/public/safe-file-store'
import * as stt from '../../packages/server/src/modules/studio/controllers/stt'
import * as tts from '../../packages/server/src/modules/studio/controllers/tts'
import { syncVoiceConfigToHermesProfile } from '../../packages/server/src/modules/studio/services/voice/config-sync'

const profilePath = (profile = 'work') => join(root, `${profile}.yaml`)
const readProfile = (profile = 'work') => safeFileStore.readYaml(profilePath(profile))
const controllers = { stt, tts }
const customBlock = { type: 'command', command: 'local-transcriber --url http://127.0.0.1:8000/v1', timeout: 42, custom: 'keep' }
const nativeConfig = {
  model: { default: 'unrelated-model' },
  stt: { provider: 'native-stt', enabled: false, providers: { 'native-stt': { model: 'keep-stt' } } },
  tts: { provider: 'native-tts', providers: { 'native-tts': { voice: 'keep-tts' } } },
}

function context(provider: string, body: object = {}, profile = 'work'): Context {
  return {
    state: { user: { id: 1 }, profile: { name: profile } },
    params: { provider, secretName: 'apiKey' }, request: { body }, query: {},
  } as unknown as Context
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'voice-config-sync-'))
  runtime.port = 18647
  runtime.localUsable = true
  db = new DatabaseSync(':memory:')
  for (const prefix of ['STT_PROFILE_PROVIDER_SETTINGS', 'STT_PROFILE_SETTINGS', 'TTS_PROFILE_PROVIDER_SETTINGS', 'TTS_PROFILE_SETTINGS'] as const) {
    db.exec(`CREATE TABLE ${schemas[`${prefix}_TABLE`]} (${Object.entries(schemas[`${prefix}_SCHEMA`]).map(([key, value]) => `${key} ${value}`).join(', ')})`)
  }
  for (const sql of Object.values({ ...schemas.STT_PROFILE_PROVIDER_SETTINGS_INDEXES, ...schemas.TTS_PROFILE_PROVIDER_SETTINGS_INDEXES })) db.exec(sql)
  settings.saveSttProviderSetting('work', 'custom', { secrets: { apiKey: 'synthetic-stt-key' } })
  settings.saveActiveSttProvider('work', 'custom')
  settings.saveTtsProviderSetting('work', 'custom', { secrets: { apiKey: 'synthetic-tts-key' } })
  settings.saveActiveTtsProvider('work', 'custom')
  await safeFileStore.writeYaml(profilePath(), nativeConfig)
  await writeFile(profilePath('other'), '# Another profile must stay byte-identical\nstt:\n  provider: local\n')
})
afterEach(async () => { db.close(); await rm(root, { recursive: true, force: true }); vi.restoreAllMocks() })

it.each(['stt', 'tts'] as const)('selecting/saving %s changes only that section of the requested profile', async section => {
  const otherSection = section === 'stt' ? 'tts' : 'stt'
  const otherProfile = await readFile(profilePath('other'), 'utf8')
  await controllers[section].saveSettings(context('custom', { settings: { model: 'new-model' } }))
  let saved = await readProfile()
  expect(saved[section]).toMatchObject({ provider: 'hermes-studio', providers: nativeConfig[section].providers })
  expect(saved[section].providers['hermes-studio'].command).toContain(`/voice/proxy/work/v1/${section === 'stt' ? 'audio/transcriptions' : 'tts'}`)
  expect(saved[otherSection]).toEqual(nativeConfig[otherSection])
  expect(saved.model).toEqual(nativeConfig.model)
  expect(JSON.stringify(saved)).not.toMatch(/synthetic-.*-key|synthetic-loopback-token/)
  runtime.port = 18648
  await controllers[section].saveActiveProvider(context('', { provider: 'custom' }))
  saved = await readProfile()
  expect(saved[section].providers['hermes-studio'].command).toContain(':18648/')
  expect(saved[otherSection]).toEqual(nativeConfig[otherSection])
  expect(await readFile(profilePath('other'), 'utf8')).toBe(otherProfile)
  const curlrc = join(root, 'runtime', 'hermes-studio-voice.curlrc')
  expect(await readFile(curlrc, 'utf8')).toContain('Bearer synthetic-loopback-token')
  if (process.platform !== 'win32') expect((await stat(curlrc)).mode & 0o777).toBe(0o600)
})

it.each(['stt', 'tts'] as const)('preserves an edited %s command block on explicit selection and settings saves', async section => {
  const yaml = await readProfile()
  yaml[section].providers['hermes-studio'] = customBlock
  await safeFileStore.writeYaml(profilePath(), yaml)
  await controllers[section].saveActiveProvider(context('', { provider: 'custom' }))
  await controllers[section].saveSettings(context('custom', { settings: { model: 'updated' } }))
  expect((await readProfile())[section]).toMatchObject({ provider: 'hermes-studio', providers: { 'hermes-studio': customBlock } })
})

it.each(['stt', 'tts'] as const)('deleting an inactive %s provider or secret does not write YAML', async section => {
  if (section === 'stt') settings.saveSttProviderSetting('work', 'openai', { secrets: { apiKey: 'inactive-key' } })
  else settings.saveTtsProviderSetting('work', 'openai', { secrets: { apiKey: 'inactive-key' } })
  await controllers[section].saveActiveProvider(context('', { provider: 'custom' }))
  const yaml = await readProfile()
  yaml[section].providers['hermes-studio'] = customBlock
  await safeFileStore.writeYaml(profilePath(), yaml)
  const before = '# Preserve comments as well as values\n' + await readFile(profilePath(), 'utf8')
  await writeFile(profilePath(), before)
  await controllers[section].deleteSecret(context('openai'))
  expect(section === 'stt' ? settings.getSttProviderSetting('work', 'openai')?.secrets : settings.getTtsProviderSetting('work', 'openai')?.secrets).toEqual({})
  await controllers[section].deleteProvider(context('openai'))
  expect(section === 'stt' ? settings.getSttProviderSetting('work', 'openai') : settings.getTtsProviderSetting('work', 'openai')).toBeNull()
  expect(await readFile(profilePath(), 'utf8')).toBe(before)
})

it.each(['stt', 'tts'] as const)('active %s secret removal falls back only for a Studio-owned selection', async section => {
  await controllers[section].saveActiveProvider(context('', { provider: 'custom' }))
  const before = await readProfile()
  await controllers[section].deleteSecret(context('custom'))
  const after = await readProfile()
  expect(after[section].provider).toBe(section === 'stt' ? 'local' : 'edge')
  expect(after[section].providers).toEqual(before[section].providers)
  expect(after[section === 'stt' ? 'tts' : 'stt']).toEqual(before[section === 'stt' ? 'tts' : 'stt'])
})

it.each(['stt', 'tts'] as const)('active %s provider removal uses its fallback without changing the other type', async section => {
  await controllers[section].saveActiveProvider(context('', { provider: 'custom' }))
  const otherSection = section === 'stt' ? 'tts' : 'stt'
  const before = (await readProfile())[otherSection]
  const ctx = context('custom')
  await controllers[section].deleteProvider(ctx)
  expect(ctx.body).toMatchObject({ success: true, deleted: true, activeProvider: section === 'stt' ? 'browser' : 'edge' })
  expect((await readProfile())[section].provider).toBe(section === 'stt' ? 'local' : 'hermes-studio')
  expect((await readProfile())[otherSection]).toEqual(before)
})

it.each(['stt', 'tts'] as const)('active %s removal preserves native selections and edited Studio commands', async section => {
  for (const edited of [false, true]) {
    const yaml = structuredClone(nativeConfig) as Record<string, any>
    if (edited) { yaml[section].provider = 'hermes-studio'; yaml[section].providers['hermes-studio'] = customBlock }
    await safeFileStore.writeYaml(profilePath(), yaml)
    const before = '# Hand-maintained config\n' + await readFile(profilePath(), 'utf8')
    await writeFile(profilePath(), before)
    await controllers[section].deleteSecret(context('custom'))
    await controllers[section].deleteProvider(context('custom'))
    expect(await readFile(profilePath(), 'utf8')).toBe(before)
    if (section === 'stt') settings.saveActiveSttProvider('work', 'custom')
    else settings.saveActiveTtsProvider('work', 'custom')
  }
})

it('keeps local/browser STT selection and Gemini output formats working', async () => {
  await stt.saveActiveProvider(context('', { provider: 'local' }))
  const local = (await readProfile()).stt.providers['hermes-studio']
  expect(local).toMatchObject({ type: 'command', output_format: 'txt' })
  await stt.saveActiveProvider(context('', { provider: 'browser' }))
  expect((await readProfile()).stt).toMatchObject({ provider: 'local', providers: { 'hermes-studio': local } })
  await tts.saveSettings(context('gemini', { secrets: { apiKey: 'synthetic-gemini-key' } }))
  expect((await readProfile()).tts.providers['hermes-studio']).toMatchObject({ output_format: 'wav' })
  await tts.saveActiveProvider(context('', { provider: 'edge' }))
  expect((await readProfile()).tts.providers['hermes-studio']).toMatchObject({ output_format: 'mp3' })
})

it('reports skipped sections unchanged and contains profile-write failures', async () => {
  expect(await syncVoiceConfigToHermesProfile('work', 'stt')).toEqual({ stt: 'unchanged', tts: 'unchanged' })
  vi.spyOn(safeFileStore, 'updateYaml').mockRejectedValueOnce(new Error('synthetic write failure'))
  expect(await syncVoiceConfigToHermesProfile('work', 'tts', { selectProvider: true })).toEqual({ stt: 'unchanged', tts: 'unchanged' })
  expect(await readProfile()).toEqual(nativeConfig)
})
