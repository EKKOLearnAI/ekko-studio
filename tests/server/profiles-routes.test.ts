import { existsSync, readFileSync } from 'fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { Readable } from 'stream'
import AdmZip from 'adm-zip'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const agentBridgeMocks = vi.hoisted(() => ({
  destroyAll: vi.fn(),
  destroyProfile: vi.fn(),
}))

const skillInjectorMocks = vi.hoisted(() => ({
  injectMissingSkills: vi.fn(),
  resolveTargetDirForProfile: vi.fn(),
}))

const sessionDeleterMocks = vi.hoisted(() => ({
  switchProfile: vi.fn(),
}))

const gatewayAutostartMocks = vi.hoisted(() => ({
  getGatewayRuntimeStatusForProfile: vi.fn(),
  prepareGatewayForProfileDelete: vi.fn(),
  restartGatewayForProfile: vi.fn(),
}))

const agentStatusMocks = vi.hoisted(() => ({
  hermesAvailable: true,
}))

// Mock hermes-cli
vi.mock('../../packages/server/src/modules/hermes/services/runtime/cli', () => ({
  listProfiles: vi.fn(),
  getProfile: vi.fn(),
  createProfile: vi.fn(),
  deleteProfile: vi.fn(),
  renameProfile: vi.fn(),
  useProfile: vi.fn(),
  stopGateway: vi.fn(),
  startGateway: vi.fn(),
  startGatewayBackground: vi.fn(),
  setupReset: vi.fn(),
  exportProfile: vi.fn(),
  importProfile: vi.fn(),
  ARCHIVE_TIMEOUT_CODE: 'archive_timeout',
}))

vi.mock('../../packages/server/src/modules/hermes/services/bridge', () => ({
  AgentBridgeClient: vi.fn(() => ({
    destroyAll: agentBridgeMocks.destroyAll,
    destroyProfile: agentBridgeMocks.destroyProfile,
  })),
}))

vi.mock('../../packages/server/src/modules/hermes/services/skills/injector', () => {
  const HermesSkillInjector = vi.fn(() => ({
    injectMissingSkills: skillInjectorMocks.injectMissingSkills,
  })) as any
  HermesSkillInjector.resolveTargetDirForProfile = skillInjectorMocks.resolveTargetDirForProfile
  return { HermesSkillInjector }
})

vi.mock('../../packages/server/src/modules/hermes/services/history/session-deleter', () => ({
  SessionDeleter: {
    getInstance: vi.fn(() => sessionDeleterMocks),
  },
}))

vi.mock('../../packages/server/src/modules/hermes/services/gateway/autostart', () => ({
  getGatewayRuntimeStatusForProfile: gatewayAutostartMocks.getGatewayRuntimeStatusForProfile,
  prepareGatewayForProfileDelete: gatewayAutostartMocks.prepareGatewayForProfileDelete,
  restartGatewayForProfile: gatewayAutostartMocks.restartGatewayForProfile,
}))

vi.mock('../../packages/server/src/modules/studio/public/agent-status-registry', () => ({
  isHermesAgentAvailable: vi.fn(() => agentStatusMocks.hermesAvailable),
}))

import * as hermesCli from '../../packages/server/src/modules/hermes/services/runtime/cli'
import { AgentBridgeClient } from '../../packages/server/src/modules/hermes/services/bridge'

describe('Profile Routes', () => {
  const originalHermesHome = process.env.HERMES_HOME
  const originalWebUiHome = process.env.HERMES_WEB_UI_HOME
  const tempHomes: string[] = []

  beforeEach(() => {
    vi.clearAllMocks()
    agentStatusMocks.hermesAvailable = true
    agentBridgeMocks.destroyProfile.mockResolvedValue({ destroyed: 0 })
    gatewayAutostartMocks.prepareGatewayForProfileDelete.mockResolvedValue(undefined)
    skillInjectorMocks.injectMissingSkills.mockResolvedValue({ targets: [] })
    skillInjectorMocks.resolveTargetDirForProfile.mockImplementation((name: string) => join('/tmp/hermes-skills', name))
  })

  afterEach(async () => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (originalWebUiHome === undefined) delete process.env.HERMES_WEB_UI_HOME
    else process.env.HERMES_WEB_UI_HOME = originalWebUiHome
    await Promise.all(tempHomes.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  })

  describe('hermes-cli wrapper', () => {
    it('listProfiles returns array', async () => {
      const mockProfiles = [{ name: 'default', active: true }]
      vi.mocked(hermesCli.listProfiles).mockResolvedValue(mockProfiles as any)

      const result = await hermesCli.listProfiles()
      expect(result).toEqual(mockProfiles)
    })

    it('getProfile returns profile detail', async () => {
      const mockDetail = { name: 'default', path: '/tmp/default' }
      vi.mocked(hermesCli.getProfile).mockResolvedValue(mockDetail as any)

      const result = await hermesCli.getProfile('default')
      expect(result).toEqual(mockDetail)
      expect(hermesCli.getProfile).toHaveBeenCalledWith('default')
    })

    it('createProfile calls CLI with name and clone flag', async () => {
      vi.mocked(hermesCli.createProfile).mockResolvedValue('Profile created')

      await hermesCli.createProfile('test', true)

      expect(hermesCli.createProfile).toHaveBeenCalledWith('test', true)
    })

    it('clone creation copies only the configured model provider auth for the new profile', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-profile-clone-auth-'))
      tempHomes.push(hermesHome)
      process.env.HERMES_HOME = hermesHome
      await writeFile(join(hermesHome, 'active_profile'), 'default\n', 'utf-8')
      await writeFile(join(hermesHome, 'auth.json'), JSON.stringify({
        providers: {
          'openai-codex': { access_token: 'codex-provider-token' },
          anthropic: { access_token: 'anthropic-provider-token' },
        },
        credential_pool: {
          'openai-codex': [{ access_token: 'codex-pool-token' }],
          anthropic: [{ access_token: 'anthropic-pool-token' }],
        },
      }, null, 2), 'utf-8')
      vi.mocked(hermesCli.createProfile).mockImplementation(async (name: string) => {
        const profileDir = join(hermesHome, 'profiles', name)
        await mkdir(profileDir, { recursive: true })
        await writeFile(join(profileDir, 'config.yaml'), [
          'model:',
          '  provider: openai-codex',
          '  default: gpt-5.5',
          '',
        ].join('\n'), 'utf-8')
        return 'Profile created'
      })
      const { create } = await import('../../packages/server/src/modules/hermes/controllers/profiles')
      const ctx: any = {
        request: { body: { name: 'cloned', clone: true } },
        status: 200,
        body: undefined,
      }

      await create(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body.copiedAuthProviders).toEqual(['openai-codex'])
      const clonedAuth = JSON.parse(readFileSync(join(hermesHome, 'profiles', 'cloned', 'auth.json'), 'utf-8'))
      expect(clonedAuth.providers['openai-codex']).toEqual({ access_token: 'codex-provider-token' })
      expect(clonedAuth.credential_pool['openai-codex']).toEqual([{ access_token: 'codex-pool-token' }])
      expect(clonedAuth.providers.anthropic).toBeUndefined()
      expect(clonedAuth.credential_pool.anthropic).toBeUndefined()
    })

    it('clones from a profile that is not the active one', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-profile-clone-source-'))
      tempHomes.push(hermesHome)
      process.env.HERMES_HOME = hermesHome
      // active profile is `default`; the clone source is a different profile
      await writeFile(join(hermesHome, 'active_profile'), 'default\n', 'utf-8')
      await writeFile(join(hermesHome, 'auth.json'), JSON.stringify({
        providers: { 'openai-codex': { access_token: 'default-token' } },
      }, null, 2), 'utf-8')
      const sourceDir = join(hermesHome, 'profiles', 'work')
      await mkdir(join(sourceDir, 'skills', 'demo'), { recursive: true })
      await writeFile(join(sourceDir, 'config.yaml'), [
        'model:',
        '  provider: openai-codex',
        '  default: gpt-5.5',
        'custom_providers:',
        '  - name: my-router',
        '    base_url: https://router.example.com/v1',
        '    api_key: router-key',
        '',
      ].join('\n'), 'utf-8')
      await writeFile(join(sourceDir, '.env'), 'OPENAI_API_KEY=from-work\nTELEGRAM_BOT_TOKEN=work-bot\n', 'utf-8')
      await writeFile(join(sourceDir, 'SOUL.md'), '# work soul\n', 'utf-8')
      await writeFile(join(sourceDir, 'skills', 'demo', 'SKILL.md'), '# demo skill\n', 'utf-8')
      await writeFile(join(sourceDir, 'auth.json'), JSON.stringify({
        providers: { 'openai-codex': { access_token: 'work-token' } },
      }, null, 2), 'utf-8')
      vi.mocked(hermesCli.createProfile).mockImplementation(async (name: string) => {
        await mkdir(join(hermesHome, 'profiles', name), { recursive: true })
        return 'Profile created'
      })
      const { create } = await import('../../packages/server/src/modules/hermes/controllers/profiles')
      const ctx: any = {
        request: { body: { name: 'cloned', cloneFrom: 'work' } },
        status: 200,
        body: undefined,
      }

      await create(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body.clonedFrom).toBe('work')
      // the CLI's --clone can only read the active profile, so it must not be used here
      expect(hermesCli.createProfile).toHaveBeenCalledWith('cloned', false)
      const clonedDir = join(hermesHome, 'profiles', 'cloned')
      const clonedConfig = readFileSync(join(clonedDir, 'config.yaml'), 'utf-8')
      expect(clonedConfig).toContain('gpt-5.5')
      // model providers configured on the source profile come across with it
      expect(clonedConfig).toContain('my-router')
      expect(clonedConfig).toContain('router-key')
      expect(readFileSync(join(clonedDir, 'SOUL.md'), 'utf-8')).toContain('work soul')
      expect(readFileSync(join(clonedDir, 'skills', 'demo', 'SKILL.md'), 'utf-8')).toContain('demo skill')
      // auth comes from the chosen source, not from the active profile
      const clonedAuth = JSON.parse(readFileSync(join(clonedDir, 'auth.json'), 'utf-8'))
      expect(clonedAuth.providers['openai-codex']).toEqual({ access_token: 'work-token' })
      // smart cleanup still runs on the copied .env
      const clonedEnv = readFileSync(join(clonedDir, '.env'), 'utf-8')
      expect(clonedEnv).toContain('OPENAI_API_KEY=from-work')
      expect(clonedEnv).not.toContain('TELEGRAM_BOT_TOKEN')
      expect(ctx.body.strippedCredentials).toContain('TELEGRAM_BOT_TOKEN')
    })

    it('delegates to the CLI --clone when the source is the active profile', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-profile-clone-active-'))
      tempHomes.push(hermesHome)
      process.env.HERMES_HOME = hermesHome
      await writeFile(join(hermesHome, 'active_profile'), 'work\n', 'utf-8')
      await mkdir(join(hermesHome, 'profiles', 'work'), { recursive: true })
      vi.mocked(hermesCli.createProfile).mockImplementation(async (name: string) => {
        await mkdir(join(hermesHome, 'profiles', name), { recursive: true })
        return 'Profile created'
      })
      const { create } = await import('../../packages/server/src/modules/hermes/controllers/profiles')
      const ctx: any = {
        request: { body: { name: 'cloned', cloneFrom: 'work' } },
        status: 200,
        body: undefined,
      }

      await create(ctx)

      expect(ctx.status).toBe(200)
      expect(hermesCli.createProfile).toHaveBeenCalledWith('cloned', true)
      expect(ctx.body.clonedFrom).toBe('work')
    })

    it('keeps clone=true without a source meaning "the active profile"', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-profile-clone-legacy-'))
      tempHomes.push(hermesHome)
      process.env.HERMES_HOME = hermesHome
      await writeFile(join(hermesHome, 'active_profile'), 'default\n', 'utf-8')
      vi.mocked(hermesCli.createProfile).mockImplementation(async (name: string) => {
        await mkdir(join(hermesHome, 'profiles', name), { recursive: true })
        return 'Profile created'
      })
      const { create } = await import('../../packages/server/src/modules/hermes/controllers/profiles')
      const ctx: any = {
        request: { body: { name: 'cloned', clone: true } },
        status: 200,
        body: undefined,
      }

      await create(ctx)

      expect(hermesCli.createProfile).toHaveBeenCalledWith('cloned', true)
      expect(ctx.body.clonedFrom).toBe('default')
    })

    it('rejects a clone source that does not exist', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-profile-clone-missing-'))
      tempHomes.push(hermesHome)
      process.env.HERMES_HOME = hermesHome
      await writeFile(join(hermesHome, 'active_profile'), 'default\n', 'utf-8')
      vi.mocked(hermesCli.createProfile).mockResolvedValue('Profile created')
      const { create } = await import('../../packages/server/src/modules/hermes/controllers/profiles')
      const ctx: any = {
        request: { body: { name: 'cloned', cloneFrom: 'ghost' } },
        status: 200,
        body: undefined,
      }

      await create(ctx)

      expect(ctx.status).toBe(400)
      expect(ctx.body.error).toContain('ghost')
      expect(hermesCli.createProfile).not.toHaveBeenCalled()
    })

    it('rejects a clone source containing path separators', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-profile-clone-traversal-'))
      tempHomes.push(hermesHome)
      process.env.HERMES_HOME = hermesHome
      await writeFile(join(hermesHome, 'active_profile'), 'default\n', 'utf-8')
      vi.mocked(hermesCli.createProfile).mockResolvedValue('Profile created')
      const { create } = await import('../../packages/server/src/modules/hermes/controllers/profiles')
      const ctx: any = {
        request: { body: { name: 'cloned', cloneFrom: '../../etc' } },
        status: 200,
        body: undefined,
      }

      await create(ctx)

      expect(ctx.status).toBe(400)
      expect(hermesCli.createProfile).not.toHaveBeenCalled()
    })

    it('deleteProfile calls CLI with name', async () => {
      vi.mocked(hermesCli.deleteProfile).mockResolvedValue(true)

      await hermesCli.deleteProfile('test')

      expect(hermesCli.deleteProfile).toHaveBeenCalledWith('test')
    })

    it('renameProfile calls CLI with old and new name', async () => {
      vi.mocked(hermesCli.renameProfile).mockResolvedValue(true)

      await hermesCli.renameProfile('old', 'new')

      expect(hermesCli.renameProfile).toHaveBeenCalledWith('old', 'new')
    })
  })

  describe('profile export failures', () => {
    it('uses a unique output directory and removes it after the response finishes', async () => {
      let outputPath = ''
      vi.mocked(hermesCli.exportProfile).mockImplementation(async (_name, path) => {
        outputPath = path || ''
        await writeFile(outputPath, 'complete archive', 'utf-8')
        return 'Profile exported'
      })
      const responseHandlers = new Map<string, () => void>()
      const { exportProfile } = await import('../../packages/server/src/modules/hermes/controllers/profiles')
      const ctx: any = {
        params: { name: 'mohamed' },
        status: 200,
        body: undefined,
        set: vi.fn(),
        res: {
          on: vi.fn((event: string, handler: () => void) => {
            responseHandlers.set(event, handler)
          }),
        },
      }

      await exportProfile(ctx)

      expect(dirname(outputPath)).toContain('hermes-profile-export-')
      expect(existsSync(outputPath)).toBe(true)
      responseHandlers.get('finish')?.()
      await vi.waitFor(() => {
        expect(existsSync(dirname(outputPath))).toBe(false)
      })
      ctx.body.destroy()
    })

    it('answers a timed-out export with 504 and a code the UI can act on', async () => {
      let outputPath = ''
      vi.mocked(hermesCli.exportProfile).mockImplementation(async (_name, path) => {
        outputPath = path || ''
        await writeFile(outputPath, 'partial archive', 'utf-8')
        throw Object.assign(
          new Error("Export of profile 'mohamed' timed out after 10 minutes — the archive is too large"),
          { code: 'archive_timeout' },
        )
      })
      const { exportProfile } = await import('../../packages/server/src/modules/hermes/controllers/profiles')
      const ctx: any = { params: { name: 'mohamed' }, status: 200, body: undefined, set: vi.fn(), res: { on: vi.fn() } }

      await exportProfile(ctx)

      expect(ctx.status).toBe(504)
      expect(ctx.body.code).toBe('archive_timeout')
      expect(ctx.body.error).toContain('timed out')
      expect(outputPath).not.toBe('')
      expect(existsSync(dirname(outputPath))).toBe(false)
    })

    it('still answers a real export failure with 500', async () => {
      vi.mocked(hermesCli.exportProfile).mockRejectedValue(new Error("Failed to export profile: profile 'ghost' not found"))
      const { exportProfile } = await import('../../packages/server/src/modules/hermes/controllers/profiles')
      const ctx: any = { params: { name: 'ghost' }, status: 200, body: undefined, set: vi.fn(), res: { on: vi.fn() } }

      await exportProfile(ctx)

      expect(ctx.status).toBe(500)
      expect(ctx.body.code).toBeUndefined()
    })
  })

  describe('profile import temp files', () => {
    it('sanitizes the upload name and removes the request temp directory', async () => {
      const boundary = 'profile-archive-boundary'
      const multipart = [
        `--${boundary}\r\n`,
        'Content-Disposition: form-data; name="file"; filename="../../profile.tar.gz"\r\n',
        'Content-Type: application/gzip\r\n\r\n',
        'archive-data',
        `\r\n--${boundary}--\r\n`,
      ].join('')
      let archivePath = ''
      vi.mocked(hermesCli.importProfile).mockImplementation(async (path) => {
        archivePath = path
        expect(existsSync(path)).toBe(true)
        return 'Profile imported'
      })
      const { importProfile } = await import('../../packages/server/src/modules/hermes/controllers/profiles')
      const ctx: any = {
        get: vi.fn(() => `multipart/form-data; boundary=${boundary}`),
        req: Readable.from([Buffer.from(multipart, 'latin1')]),
        status: 200,
        body: undefined,
      }

      await importProfile(ctx)

      expect(ctx.body).toMatchObject({ success: true })
      expect(basename(archivePath)).toBe('profile.tar.gz')
      expect(existsSync(dirname(archivePath))).toBe(false)
    })
  })

  describe('profile rename validation', () => {
    it('rejects reserved profile names before calling Hermes CLI', async () => {
      vi.mocked(hermesCli.renameProfile).mockResolvedValue(true)
      const { rename } = await import('../../packages/server/src/modules/hermes/controllers/profiles')
      const ctx: any = {
        params: { name: 'work' },
        request: { body: { new_name: 'hermes' } },
        status: 200,
        body: undefined,
      }

      await rename(ctx)

      expect(ctx.status).toBe(400)
      expect(ctx.body).toEqual({ error: "Profile name 'hermes' is reserved and cannot be used" })
      expect(hermesCli.renameProfile).not.toHaveBeenCalled()
    })
  })

  describe('profile lifecycle without Hermes', () => {
    it('creates a normalized Studio-owned profile skeleton without invoking Hermes CLI', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'studio-native-profile-create-'))
      tempHomes.push(hermesHome)
      process.env.HERMES_HOME = hermesHome
      agentStatusMocks.hermesAvailable = false
      const { create } = await import('../../packages/server/src/modules/hermes/controllers/profiles')
      const ctx: any = {
        request: { body: { name: '  Work_One  ', clone: false } },
        status: 200,
        body: undefined,
      }

      await create(ctx)

      const profileDir = join(hermesHome, 'profiles', 'work_one')
      expect(ctx.status).toBe(200)
      expect(ctx.body).toMatchObject({ success: true, message: "Profile 'work_one' created by Studio" })
      expect(hermesCli.createProfile).not.toHaveBeenCalled()
      expect(existsSync(join(profileDir, 'config.yaml'))).toBe(true)
      expect(existsSync(join(profileDir, '.env'))).toBe(true)
      expect(existsSync(join(profileDir, 'SOUL.md'))).toBe(true)
      expect(existsSync(join(profileDir, 'skills'))).toBe(true)
      expect(skillInjectorMocks.resolveTargetDirForProfile).toHaveBeenCalledWith('work_one')
    })

    it('rejects path-like and command names before touching either implementation', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'studio-native-profile-invalid-'))
      tempHomes.push(hermesHome)
      process.env.HERMES_HOME = hermesHome
      agentStatusMocks.hermesAvailable = false
      const { create } = await import('../../packages/server/src/modules/hermes/controllers/profiles')

      for (const name of ['../outside', 'work/name', '.hidden', 'gateway']) {
        const ctx: any = { request: { body: { name } }, status: 200, body: undefined }
        await create(ctx)
        expect(ctx.status).toBe(400)
        expect(ctx.body.code).toMatch(/^profile_name_/)
      }

      expect(hermesCli.createProfile).not.toHaveBeenCalled()
      expect(existsSync(join(hermesHome, 'profiles'))).toBe(false)
    })

    it('deletes only the selected profile directory and resets active_profile', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'studio-native-profile-delete-'))
      tempHomes.push(hermesHome)
      process.env.HERMES_HOME = hermesHome
      agentStatusMocks.hermesAvailable = false
      const profileDir = join(hermesHome, 'profiles', 'work')
      const siblingDir = join(hermesHome, 'profiles', 'keep')
      await mkdir(profileDir, { recursive: true })
      await mkdir(siblingDir, { recursive: true })
      await writeFile(join(hermesHome, 'active_profile'), 'work\n', 'utf-8')
      const { remove } = await import('../../packages/server/src/modules/hermes/controllers/profiles')
      const ctx: any = { params: { name: 'work' }, status: 200, body: undefined }

      await remove(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body).toEqual({ success: true })
      expect(agentBridgeMocks.destroyProfile).not.toHaveBeenCalled()
      expect(gatewayAutostartMocks.prepareGatewayForProfileDelete).toHaveBeenCalledWith('work', { useHermesCli: false })
      expect(hermesCli.deleteProfile).not.toHaveBeenCalled()
      expect(existsSync(profileDir)).toBe(false)
      expect(existsSync(siblingDir)).toBe(true)
      expect(readFileSync(join(hermesHome, 'active_profile'), 'utf-8')).toBe('default\n')
    })

    it('lists profiles from disk without invoking Hermes CLI', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'studio-native-profile-list-'))
      tempHomes.push(hermesHome)
      process.env.HERMES_HOME = hermesHome
      agentStatusMocks.hermesAvailable = false
      await mkdir(join(hermesHome, 'profiles', 'work'), { recursive: true })
      const { list } = await import('../../packages/server/src/modules/hermes/controllers/profiles')
      const ctx: any = {
        state: { profile: { name: 'work' } },
        get: vi.fn(),
        status: 200,
        body: undefined,
      }

      await list(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body.profiles.map((profile: any) => profile.name)).toEqual(['default', 'work'])
      expect(hermesCli.listProfiles).not.toHaveBeenCalled()
    })

    it('exports a profile without invoking Hermes CLI', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'studio-native-profile-export-'))
      tempHomes.push(hermesHome)
      process.env.HERMES_HOME = hermesHome
      agentStatusMocks.hermesAvailable = false
      await mkdir(join(hermesHome, 'profiles', 'work'), { recursive: true })
      await writeFile(join(hermesHome, 'profiles', 'work', 'config.yaml'), 'model:\n  default: test\n', 'utf8')
      const { exportProfile } = await import('../../packages/server/src/modules/hermes/controllers/profiles')
      const ctx: any = {
        params: { name: 'work' },
        status: 200,
        body: undefined,
        set: vi.fn(),
        res: { on: vi.fn() },
      }

      await exportProfile(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body).toBeInstanceOf(Readable)
      expect(hermesCli.exportProfile).not.toHaveBeenCalled()
      for await (const _chunk of ctx.body) {
        // Drain the response so its temporary directory is cleaned up.
      }
    })

    it('imports a profile and injects bundled skills without invoking Hermes CLI', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'studio-native-profile-import-'))
      tempHomes.push(hermesHome)
      process.env.HERMES_HOME = hermesHome
      agentStatusMocks.hermesAvailable = false
      const zip = new AdmZip()
      zip.addFile('travel/config.yaml', Buffer.from('model:\n  default: zip-model\n'))
      const archive = zip.toBuffer()
      const boundary = 'studio-native-profile-import-boundary'
      const multipart = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="travel.zip"\r\nContent-Type: application/zip\r\n\r\n`, 'latin1'),
        archive,
        Buffer.from(`\r\n--${boundary}--\r\n`, 'latin1'),
      ])
      const { importProfile } = await import('../../packages/server/src/modules/hermes/controllers/profiles')
      const ctx: any = {
        get: vi.fn(() => `multipart/form-data; boundary=${boundary}`),
        req: Readable.from([multipart]),
        status: 200,
        body: undefined,
      }

      await importProfile(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body).toEqual({ success: true, message: "Profile 'travel' imported by Studio" })
      expect(await readFile(join(hermesHome, 'profiles', 'travel', 'config.yaml'), 'utf8')).toContain('zip-model')
      expect(skillInjectorMocks.resolveTargetDirForProfile).toHaveBeenCalledWith('travel')
      expect(hermesCli.importProfile).not.toHaveBeenCalled()
    })
  })

  describe('profile deletion with Hermes', () => {
    it('prepares the profile gateway for deletion before calling Hermes CLI delete', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-profile-delete-'))
      tempHomes.push(hermesHome)
      process.env.HERMES_HOME = hermesHome
      const profileDir = join(hermesHome, 'profiles', 'work')
      await mkdir(profileDir, { recursive: true })
      await writeFile(join(profileDir, 'config.yaml'), 'model:\n  default: test\n', 'utf-8')

      gatewayAutostartMocks.prepareGatewayForProfileDelete.mockImplementation(async () => {
        await rm(profileDir, { recursive: true, force: true })
      })
      vi.mocked(hermesCli.deleteProfile).mockResolvedValue(true)
      const { remove } = await import('../../packages/server/src/modules/hermes/controllers/profiles')
      const ctx: any = { params: { name: 'work' }, status: 200, body: undefined }

      await remove(ctx)

      expect(gatewayAutostartMocks.prepareGatewayForProfileDelete).toHaveBeenCalledWith('work', { useHermesCli: true })
      expect(hermesCli.deleteProfile).toHaveBeenCalledWith('work')
      expect(ctx.status).toBe(200)
      expect(ctx.body).toEqual({ success: true })
    })

    it('does not return success when Hermes CLI reports delete success but the profile directory remains', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-profile-delete-'))
      tempHomes.push(hermesHome)
      process.env.HERMES_HOME = hermesHome
      const profileDir = join(hermesHome, 'profiles', 'work')
      await mkdir(profileDir, { recursive: true })
      await writeFile(join(profileDir, 'config.yaml'), 'model:\n  default: test\n', 'utf-8')
      vi.mocked(hermesCli.deleteProfile).mockResolvedValue(true)
      const { remove } = await import('../../packages/server/src/modules/hermes/controllers/profiles')
      const ctx: any = { params: { name: 'work' }, status: 200, body: undefined }

      await remove(ctx)

      expect(ctx.status).toBe(500)
      expect(ctx.body).toEqual({ error: 'Failed to delete profile: profile directory still exists' })
      expect(existsSync(profileDir)).toBe(true)
    })

    it('leaves a reserved profile directory to Hermes when Hermes is available', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-profile-delete-'))
      tempHomes.push(hermesHome)
      process.env.HERMES_HOME = hermesHome
      const badProfileDir = join(hermesHome, 'profiles', 'hermes')
      await mkdir(badProfileDir, { recursive: true })
      await writeFile(join(badProfileDir, 'config.yaml'), 'model:\n  default: bad\n', 'utf-8')
      await writeFile(join(hermesHome, 'active_profile'), 'hermes\n', 'utf-8')
      vi.mocked(hermesCli.deleteProfile).mockResolvedValue(false)
      const { remove } = await import('../../packages/server/src/modules/hermes/controllers/profiles')
      const ctx: any = { params: { name: 'hermes' }, status: 200, body: undefined }

      await remove(ctx)

      expect(ctx.status).toBe(500)
      expect(ctx.body).toEqual({ error: 'Failed to delete profile' })
      expect(hermesCli.deleteProfile).toHaveBeenCalledWith('hermes')
      expect(existsSync(badProfileDir)).toBe(true)
      expect(readFileSync(join(hermesHome, 'active_profile'), 'utf-8')).toBe('hermes\n')
    })

    it('does not bypass Hermes CLI failures for normal profile names', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-profile-delete-'))
      tempHomes.push(hermesHome)
      process.env.HERMES_HOME = hermesHome
      const profileDir = join(hermesHome, 'profiles', 'work')
      await mkdir(profileDir, { recursive: true })
      vi.mocked(hermesCli.deleteProfile).mockResolvedValue(false)
      const { remove } = await import('../../packages/server/src/modules/hermes/controllers/profiles')
      const ctx: any = { params: { name: 'work' }, status: 200, body: undefined }

      await remove(ctx)

      expect(ctx.status).toBe(500)
      expect(ctx.body).toEqual({ error: 'Failed to delete profile' })
      expect(existsSync(profileDir)).toBe(true)
    })
  })

  describe('Hermes CLI active profile switch', () => {
    it('only destroys bridge sessions for the target profile', async () => {
      const hermesHome = await mkdtemp(join(tmpdir(), 'hermes-profile-switch-'))
      tempHomes.push(hermesHome)
      process.env.HERMES_HOME = hermesHome
      const profileDir = join(hermesHome, 'profiles', 'work')
      await mkdir(profileDir, { recursive: true })
      await writeFile(join(profileDir, 'config.yaml'), 'model:\n  default: gpt-test\n', 'utf-8')
      await writeFile(join(hermesHome, 'active_profile'), 'work\n', 'utf-8')
      vi.mocked(hermesCli.useProfile).mockResolvedValue('Switched to work')
      vi.mocked(hermesCli.getProfile).mockResolvedValue({
        name: 'work',
        path: profileDir,
        model: 'gpt-test',
        provider: 'test',
        skills: 0,
        hasEnv: false,
        hasSoulMd: false,
      } as any)
      agentBridgeMocks.destroyProfile.mockResolvedValue({ destroyed: 2 })
      const { switchProfile } = await import('../../packages/server/src/modules/hermes/controllers/profiles')
      const ctx: any = {
        request: { body: { name: 'work' } },
        status: 200,
        body: undefined,
      }

      await switchProfile(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body).toMatchObject({ success: true, active: 'work' })
      expect(agentBridgeMocks.destroyProfile).toHaveBeenCalledWith('work')
      expect(agentBridgeMocks.destroyAll).not.toHaveBeenCalled()
      expect(sessionDeleterMocks.switchProfile).toHaveBeenCalledWith('work')
    })
  })

  describe('profile runtime restart', () => {
    it('uses the configurable bridge timeout for explicit profile cleanup', async () => {
      vi.mocked(hermesCli.listProfiles).mockResolvedValue([{
        name: 'work',
        active: true,
        model: 'gpt-test',
        alias: '',
      }] as any)
      gatewayAutostartMocks.getGatewayRuntimeStatusForProfile.mockResolvedValue({
        running: false,
        profile: 'work',
      })
      agentBridgeMocks.destroyProfile.mockResolvedValue({ destroyed: 2 })
      const { restartProfileRuntime } = await import('../../packages/server/src/modules/hermes/controllers/profiles')
      const ctx: any = { params: { name: 'work' }, status: 200, body: undefined }

      await restartProfileRuntime(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body).toMatchObject({ success: true, destroyed: 2 })
      expect(vi.mocked(AgentBridgeClient)).toHaveBeenNthCalledWith(1, { connectRetryMs: 0 })
      expect(agentBridgeMocks.destroyProfile).toHaveBeenCalledWith('work')
    })
  })

  describe('profile avatars', () => {
    it('returns a compressed image avatar from the App-only profile endpoint', async () => {
      const webUiHome = await mkdtemp(join(tmpdir(), 'hermes-web-ui-app-avatar-'))
      tempHomes.push(webUiHome)
      process.env.HERMES_WEB_UI_HOME = webUiHome
      const metadataDir = join(webUiHome, 'profile-metadata', Buffer.from('work', 'utf-8').toString('base64url'))
      await mkdir(metadataDir, { recursive: true })
      const { default: sharp } = await import('sharp')
      const source = await sharp({
        create: {
          width: 640,
          height: 480,
          channels: 4,
          background: { r: 53, g: 88, b: 212, alpha: 1 },
        },
      }).png().toBuffer()
      await writeFile(join(metadataDir, 'avatar.bin'), source)
      await writeFile(join(metadataDir, 'avatar.json'), JSON.stringify({
        type: 'image',
        file: 'avatar.bin',
        mime: 'image/png',
        updatedAt: 123,
      }), 'utf-8')
      vi.mocked(hermesCli.listProfiles).mockResolvedValue([{
        name: 'work',
        active: true,
        model: 'test-model',
        alias: '',
      }] as any)
      const { listForApp } = await import('../../packages/server/src/modules/hermes/controllers/profiles')
      const ctx: any = {
        state: { profile: { name: 'work' } },
        status: 200,
        body: undefined,
      }

      await listForApp(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body.profiles).toHaveLength(1)
      const dataUrl = String(ctx.body.profiles[0].avatar.dataUrl)
      expect(dataUrl).toMatch(/^data:image\/webp;base64,/)
      const preview = Buffer.from(dataUrl.split(',', 2)[1], 'base64')
      const metadata = await sharp(preview).metadata()
      expect(metadata.width).toBe(128)
      expect(metadata.height).toBe(96)
      expect(preview.length).toBeLessThan(source.length)
    })

    it('keeps generated App avatars as seed metadata instead of embedding SVG', async () => {
      const webUiHome = await mkdtemp(join(tmpdir(), 'hermes-web-ui-app-avatar-'))
      tempHomes.push(webUiHome)
      process.env.HERMES_WEB_UI_HOME = webUiHome
      const metadataDir = join(webUiHome, 'profile-metadata', Buffer.from('work', 'utf-8').toString('base64url'))
      await mkdir(metadataDir, { recursive: true })
      await writeFile(join(metadataDir, 'avatar.json'), JSON.stringify({
        type: 'generated',
        seed: 'app-seed',
        updatedAt: 456,
      }), 'utf-8')
      vi.mocked(hermesCli.listProfiles).mockResolvedValue([{
        name: 'work',
        active: true,
        model: 'test-model',
        alias: '',
      }] as any)
      const { listForApp } = await import('../../packages/server/src/modules/hermes/controllers/profiles')
      const ctx: any = {
        state: { profile: { name: 'work' } },
        status: 200,
        body: undefined,
      }

      await listForApp(ctx)

      expect(ctx.body.profiles[0].avatar).toEqual({
        type: 'generated',
        seed: 'app-seed',
        updatedAt: 456,
      })
      expect(ctx.body.profiles[0].avatar.dataUrl).toBeUndefined()
    })

    it('stores generated avatar metadata under the Web UI home', async () => {
      const webUiHome = await mkdtemp(join(tmpdir(), 'hermes-web-ui-avatar-'))
      tempHomes.push(webUiHome)
      process.env.HERMES_WEB_UI_HOME = webUiHome
      const { updateAvatar } = await import('../../packages/server/src/modules/hermes/controllers/profiles')
      const ctx: any = {
        params: { name: 'work' },
        request: { body: { type: 'generated', seed: 'custom-seed' } },
        status: 200,
        body: undefined,
      }

      await updateAvatar(ctx)

      const metaPath = join(webUiHome, 'profile-metadata', Buffer.from('work', 'utf-8').toString('base64url'), 'avatar.json')
      expect(ctx.status).toBe(200)
      expect(ctx.body.avatar).toMatchObject({ type: 'generated', seed: 'custom-seed' })
      expect(JSON.parse(readFileSync(metaPath, 'utf-8'))).toMatchObject({
        type: 'generated',
        seed: 'custom-seed',
      })
    })

    it('stores uploaded image avatars and returns a data URL', async () => {
      const webUiHome = await mkdtemp(join(tmpdir(), 'hermes-web-ui-avatar-'))
      tempHomes.push(webUiHome)
      process.env.HERMES_WEB_UI_HOME = webUiHome
      const dataUrl = `data:image/png;base64,${Buffer.from('avatar-png').toString('base64')}`
      const { updateAvatar } = await import('../../packages/server/src/modules/hermes/controllers/profiles')
      const ctx: any = {
        params: { name: 'work' },
        request: { body: { type: 'image', dataUrl } },
        status: 200,
        body: undefined,
      }

      await updateAvatar(ctx)

      const dir = join(webUiHome, 'profile-metadata', Buffer.from('work', 'utf-8').toString('base64url'))
      const meta = JSON.parse(readFileSync(join(dir, 'avatar.json'), 'utf-8'))
      expect(ctx.status).toBe(200)
      expect(ctx.body.avatar).toMatchObject({ type: 'image', dataUrl })
      expect(meta).toMatchObject({ type: 'image', file: 'avatar.bin', mime: 'image/png' })
      expect(readFileSync(join(dir, 'avatar.bin')).toString()).toBe('avatar-png')
    })

    it('deletes profile avatar metadata', async () => {
      const webUiHome = await mkdtemp(join(tmpdir(), 'hermes-web-ui-avatar-'))
      tempHomes.push(webUiHome)
      process.env.HERMES_WEB_UI_HOME = webUiHome
      const metadataDir = join(webUiHome, 'profile-metadata', Buffer.from('work', 'utf-8').toString('base64url'))
      await mkdir(metadataDir, { recursive: true })
      await writeFile(join(metadataDir, 'avatar.json'), '{"type":"generated"}\n', 'utf-8')
      const { deleteAvatar } = await import('../../packages/server/src/modules/hermes/controllers/profiles')
      const ctx: any = { params: { name: 'work' }, status: 200, body: undefined }

      await deleteAvatar(ctx)

      expect(ctx.status).toBe(200)
      expect(ctx.body).toEqual({ success: true })
      expect(existsSync(metadataDir)).toBe(false)
    })
  })
})
