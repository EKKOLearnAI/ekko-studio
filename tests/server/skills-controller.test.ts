import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { Readable } from 'stream'

const mockListSkillUsageEventsAfterMessageId = vi.hoisted(() => vi.fn())
const mockGetActiveProfileName = vi.hoisted(() => vi.fn())
const mockGetProfileDir = vi.hoisted(() => vi.fn())
const mockUpdateConfigYamlForProfile = vi.hoisted(() => vi.fn())
const mockReadConfigYamlForProfile = vi.hoisted(() => vi.fn())
const mockSafeReadFile = vi.hoisted(() => vi.fn())
const mockExtractDescription = vi.hoisted(() => vi.fn())
const mockListFilesRecursive = vi.hoisted(() => vi.fn())
const mockGetLocalSkillUsageStats = vi.hoisted(() => vi.fn())
const mockGetSkillUsageSyncCursor = vi.hoisted(() => vi.fn())
const mockSyncExternalSkillUsageEvents = vi.hoisted(() => vi.fn())
const agentStatusMocks = vi.hoisted(() => ({ hermesAvailable: true }))

vi.mock('../../packages/server/src/modules/hermes/services/history/sessions-db', () => ({
  listSkillUsageEventsAfterMessageId: mockListSkillUsageEventsAfterMessageId,
}))

vi.mock('../../packages/server/src/modules/studio/public/agent-status-registry', () => ({
  isHermesAgentAvailable: vi.fn(() => agentStatusMocks.hermesAvailable),
}))

vi.mock('../../packages/server/src/modules/studio/public/skill-usage', () => ({
  getLocalSkillUsageStats: mockGetLocalSkillUsageStats,
  getSkillUsageSyncCursor: mockGetSkillUsageSyncCursor,
  syncExternalSkillUsageEvents: mockSyncExternalSkillUsageEvents,
}))

vi.mock('../../packages/server/src/modules/hermes/services/profiles/profile', () => ({
  getActiveProfileName: mockGetActiveProfileName,
  getProfileDir: mockGetProfileDir,
}))

vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  readConfigYamlForProfile: mockReadConfigYamlForProfile,
  updateConfigYamlForProfile: mockUpdateConfigYamlForProfile,
}))

vi.mock('../../packages/server/src/modules/studio/public/files', () => ({
  safeReadFile: mockSafeReadFile,
  extractDescription: mockExtractDescription,
  listFilesRecursive: mockListFilesRecursive,
}))

async function loadController() {
  vi.resetModules()
  await import('../../packages/server/src/bootstrap/skill-files-adapter')
  return import('../../packages/server/src/modules/hermes/controllers/skills')
}

function multipartBody(boundary: string, parts: Array<{ name: string; value: string; filename?: string; filenameStar?: string; contentType?: string }>): Buffer {
  const chunks: Buffer[] = []
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`))
    const filename = part.filenameStar
      ? `; filename*=UTF-8''${part.filenameStar}`
      : part.filename
        ? `; filename="${part.filename}"`
        : ''
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"${filename}\r\n`))
    if (part.contentType) chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`))
    chunks.push(Buffer.from('\r\n'))
    chunks.push(Buffer.from(part.value))
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return Buffer.concat(chunks)
}

describe('skills controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    agentStatusMocks.hermesAvailable = true
    mockGetActiveProfileName.mockReturnValue('default')
    mockGetProfileDir.mockImplementation((profile: string) => `/tmp/hermes-${profile}`)
    mockReadConfigYamlForProfile.mockResolvedValue({})
    mockSafeReadFile.mockImplementation(async (path: string) => {
      try {
        return await readFile(path, 'utf-8')
      } catch {
        return null
      }
    })
    mockExtractDescription.mockImplementation((content: string) => {
      return content.split('\n').find(line => line.trim() && !line.startsWith('#'))?.trim() || ''
    })
    mockListFilesRecursive.mockResolvedValue([])
    mockUpdateConfigYamlForProfile.mockImplementation(async (_profile: string, updater: (config: Record<string, any>) => Record<string, any>) => updater({}))
    mockGetLocalSkillUsageStats.mockImplementation((days: number) => ({
      stats: {
        period_days: days,
        summary: {
          total_skill_loads: 0,
          total_skill_edits: 0,
          total_skill_actions: 0,
          distinct_skills_used: 0,
        },
        by_day: [],
        top_skills: [],
      },
      sessionIds: [],
    }))
    mockGetSkillUsageSyncCursor.mockReturnValue(0)
    mockListSkillUsageEventsAfterMessageId.mockResolvedValue({ events: [], cursor: 12, reset: false })
  })

  it.each(['codex', 'pi', 'grok', 'opencode', 'dsh', 'claude'])('exposes shared skills as read-only for %s and rejects writes without touching Hermes', async target => {
    const root = await mkdtemp(join(tmpdir(), 'studio-shared-skill-'))
    const previous = process.env.HERMES_CODING_AGENT_GLOBAL_HOME
    process.env.HERMES_CODING_AGENT_GLOBAL_HOME = root
    const content = '---\nname: shared\ndescription: Shared skill\n---\nOriginal\n'
    const shared = join(root, '.agents/skills/shared/SKILL.md')
    const hermes = join(root, 'hermes/skills/shared/SKILL.md')
    mockGetProfileDir.mockReturnValue(join(root, 'hermes'))
    try {
      await mkdir(join(root, '.agents/skills/shared'), { recursive: true })
      await mkdir(join(root, 'hermes/skills/shared'), { recursive: true })
      await writeFile(shared, content)
      await writeFile(hermes, '# Hermes original')
      if (target === 'claude') {
        await mkdir(join(root, '.claude/skills'), { recursive: true })
        await symlink(join(root, '.agents/skills/shared'), join(root, '.claude/skills/shared'), 'dir')
      }
      const controller = await loadController()
      const ctx: any = { query: { target }, params: { category: 'misc', skill: 'shared' }, state: {}, request: { body: { content: content + 'Edited' } } }
      await controller.list(ctx)
      expect(ctx.body.categories.flatMap((c: any) => c.skills)).toContainEqual(expect.objectContaining({ name: 'shared', readonly: true }))
      await controller.updateSkill(ctx)
      expect(ctx.status).toBe(403)
      await controller.deleteSkill(ctx)
      expect(ctx.status).toBe(403)
      expect(await readFile(shared, 'utf8')).toBe(content)
      expect(await readFile(hermes, 'utf8')).toBe('# Hermes original')
      const readCtx = { ...ctx, params: { path: 'misc/shared/SKILL.md' } }
      await controller.readFile_(readCtx)
      expect(readCtx.body.content).toBe(content)
    } finally {
      if (previous === undefined) delete process.env.HERMES_CODING_AGENT_GLOBAL_HOME
      else process.env.HERMES_CODING_AGENT_GLOBAL_HOME = previous
      await rm(root, { recursive: true, force: true })
    }
  })

  it('protects flat shared skills and DSH aliases while keeping a same-name private skill writable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studio-shared-flat-'))
    const previous = process.env.HERMES_CODING_AGENT_GLOBAL_HOME
    process.env.HERMES_CODING_AGENT_GLOBAL_HOME = root
    const content = '---\nname: example\ndescription: Example\n---\nOriginal\n'
    try {
      await mkdir(join(root, '.agents/skills'), { recursive: true })
      await mkdir(join(root, '.dsh/skills'), { recursive: true })
      await writeFile(join(root, '.agents/skills/shared.md'), content)
      await symlink(join(root, '.agents/skills/shared.md'), join(root, '.dsh/skills/alias.md'))
      const controller = await loadController()
      for (const name of ['shared', 'alias']) {
        const ctx: any = { query: { target: 'dsh' }, params: { category: 'misc', skill: name }, request: { body: { content } } }
        await controller.updateSkill(ctx); expect(ctx.status).toBe(403)
        await controller.deleteSkill(ctx); expect(ctx.status).toBe(403)
      }
      await writeFile(join(root, '.dsh/skills/shared.md'), content)
      const ctx: any = { query: { target: 'dsh' }, params: { category: 'misc', skill: 'shared' }, request: { body: { content: content + 'Private edit' } } }
      await controller.updateSkill(ctx)
      expect(ctx.body).toEqual({ success: true })
      await controller.deleteSkill(ctx)
      expect(ctx.body).toEqual({ success: true })
      expect(await readFile(join(root, '.agents/skills/shared.md'), 'utf8')).toBe(content)
    } finally {
      if (previous === undefined) delete process.env.HERMES_CODING_AGENT_GLOBAL_HOME
      else process.env.HERMES_CODING_AGENT_GLOBAL_HOME = previous
      await rm(root, { recursive: true, force: true })
    }
  })

  it('lists, reads, edits and deletes DSH native flat and bundled skills', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studio-dsh-skills-'))
    const previous = process.env.HERMES_CODING_AGENT_GLOBAL_HOME
    process.env.HERMES_CODING_AGENT_GLOBAL_HOME = root
    const skill = (name: string, description = 'Example') => `---\nname: ${name}\ndescription: ${description}\n---\nInstructions\n`
    try {
      await mkdir(join(root, '.dsh/skills/bundle'), { recursive: true })
      await mkdir(join(root, '.agents/skills/shared'), { recursive: true })
      await mkdir(join(root, '.agents/skills/duplicate'), { recursive: true })
      await mkdir(join(root, '.dsh/skills/category/nested'), { recursive: true })
      await writeFile(join(root, '.dsh/skills/flat.md'), skill('flat'))
      await writeFile(join(root, '.dsh/skills/bundle/SKILL.md'), skill('bundle'))
      await writeFile(join(root, '.agents/skills/shared/SKILL.md'), skill('shared'))
      await writeFile(join(root, '.agents/skills/duplicate/SKILL.md'), skill('bundle'))
      await writeFile(join(root, '.dsh/skills/category/nested/SKILL.md'), skill('nested'))
      const controller = await loadController()
      const ctx: any = { query: { target: 'dsh' }, params: {}, state: {}, body: null }
      await controller.list(ctx)
      expect(ctx.body.categories[0].skills.map((s: any) => s.name)).toEqual(['bundle', 'flat', 'shared'])
      ctx.params = { path: 'misc/flat/SKILL.md' }
      await controller.readFile_(ctx)
      expect(ctx.body.content).toBe(skill('flat'))
      ctx.params = { category: 'misc', skill: 'flat' }
      ctx.request = { body: { content: skill('flat', 'Updated') } }
      await controller.updateSkill(ctx)
      expect(ctx.body).toEqual({ success: true })
      expect(await readFile(join(root, '.dsh/skills/flat.md'), 'utf8')).toContain('Updated')
      ctx.request.body.content = '# Missing frontmatter'
      await controller.updateSkill(ctx)
      expect(ctx.status).toBe(400)
      expect(await readFile(join(root, '.dsh/skills/flat.md'), 'utf8')).toContain('Updated')
      await controller.deleteSkill(ctx)
      await expect(readFile(join(root, '.dsh/skills/flat.md'))).rejects.toThrow()
      expect(await readFile(join(root, '.dsh/skills/bundle/SKILL.md'), 'utf8')).toBe(skill('bundle'))
    } finally {
      if (previous === undefined) delete process.env.HERMES_CODING_AGENT_GLOBAL_HOME
      else process.env.HERMES_CODING_AGENT_GLOBAL_HOME = previous
      await rm(root, { recursive: true, force: true })
    }
  })

  it('imports DSH skills into the global DSH home and rejects categories and invalid definitions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studio-dsh-import-'))
    const previous = process.env.HERMES_CODING_AGENT_GLOBAL_HOME
    process.env.HERMES_CODING_AGENT_GLOBAL_HOME = root
    const boundary = '----dsh-skill-test'
    const definition = '---\nname: demo\ndescription: Example\n---\nDo work\n'
    const context = (content: string, category?: string): any => ({
      query: { target: 'dsh' }, state: {},
      get: () => `multipart/form-data; boundary=${boundary}`,
      req: Readable.from([multipartBody(boundary, [
        { name: 'file', filename: 'demo/SKILL.md', value: content },
        ...(category ? [{ name: 'category', value: category }] : []),
      ])]),
    })
    try {
      const { importSkill } = await loadController()
      const bad = context('# No frontmatter')
      await importSkill(bad)
      expect(bad.status).toBe(400)
      const categorized = context(definition, 'tools')
      await importSkill(categorized)
      expect(categorized.status).toBe(400)
      const valid = context(definition)
      await importSkill(valid)
      expect(valid.body).toEqual({ success: true, name: 'demo' })
      expect(await readFile(join(root, '.dsh/skills/demo/SKILL.md'), 'utf8')).toBe(definition)
      const duplicate = context(definition)
      await importSkill(duplicate)
      expect(duplicate.status).toBe(409)
    } finally {
      if (previous === undefined) delete process.env.HERMES_CODING_AGENT_GLOBAL_HOME
      else process.env.HERMES_CODING_AGENT_GLOBAL_HOME = previous
      await rm(root, { recursive: true, force: true })
    }
  })

  it('loads skill usage from the request-scoped profile state database', async () => {
    const { usageStats } = await loadController()
    const ctx: any = { query: { days: '30' }, state: { profile: { name: 'research' } }, body: null }

    await usageStats(ctx)

    expect(mockGetLocalSkillUsageStats).toHaveBeenNthCalledWith(1, 30, undefined, 'research', false)
    expect(mockListSkillUsageEventsAfterMessageId).toHaveBeenCalledWith(0, 'research')
    expect(mockSyncExternalSkillUsageEvents).toHaveBeenCalledWith('hermes', 'research', [], 12, false)
    expect(mockGetLocalSkillUsageStats).toHaveBeenNthCalledWith(2, 30, undefined, 'research', true)
    expect(ctx.body.period_days).toBe(30)
  })

  it('falls back to active profile when no request profile is set', async () => {
    mockGetActiveProfileName.mockReturnValue('travel')
    const { usageStats } = await loadController()
    const ctx: any = { query: {}, state: {}, body: null }

    await usageStats(ctx)

    expect(mockGetLocalSkillUsageStats).toHaveBeenNthCalledWith(1, 7, undefined, 'travel', false)
    expect(mockListSkillUsageEventsAfterMessageId).toHaveBeenCalledWith(0, 'travel')
  })

  it('returns empty skill usage without reading Hermes state.db when Hermes is unavailable', async () => {
    agentStatusMocks.hermesAvailable = false
    const { usageStats } = await loadController()
    const ctx: any = { query: { days: '30' }, state: { profile: { name: 'research' } }, body: null }

    await usageStats(ctx)

    expect(mockListSkillUsageEventsAfterMessageId).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({
      period_days: 30,
      summary: {
        total_skill_loads: 0,
        total_skill_edits: 0,
        total_skill_actions: 0,
        distinct_skills_used: 0,
      },
      by_day: [],
      top_skills: [],
    })
  })

  it('toggles skills in the request-scoped profile config', async () => {
    let updatedConfig: Record<string, any> | undefined
    mockUpdateConfigYamlForProfile.mockImplementation(async (_profile: string, updater: (config: Record<string, any>) => Record<string, any>) => {
      updatedConfig = await updater({ skills: { disabled: ['old-skill'] }, model: { default: 'glm-5.1' } })
      return undefined
    })
    const { toggle } = await loadController()
    const ctx: any = {
      request: { body: { name: 'new-skill', enabled: false } },
      state: { profile: { name: 'research' } },
      body: null,
    }

    await toggle(ctx)

    expect(mockUpdateConfigYamlForProfile).toHaveBeenCalledWith('research', expect.any(Function))
    expect(updatedConfig).toEqual({
      skills: { disabled: ['old-skill', 'new-skill'] },
      model: { default: 'glm-5.1' },
    })
    expect(ctx.body).toEqual({ success: true })
  })

  it('lists configured external skill directories with external source while keeping local skills first', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-external-skills-'))
    const profileDir = join(root, 'profile')
    const localSkillDir = join(profileDir, 'skills', 'tools', 'dupe-skill')
    const externalDir = join(root, 'external-skills')
    const externalSkillDir = join(externalDir, 'tools', 'external-skill')
    const externalDupeDir = join(externalDir, 'tools', 'dupe-skill')

    await mkdir(localSkillDir, { recursive: true })
    await mkdir(externalSkillDir, { recursive: true })
    await mkdir(externalDupeDir, { recursive: true })
    await writeFile(join(localSkillDir, 'SKILL.md'), '# Local Dupe\nlocal copy\n', 'utf-8')
    await writeFile(join(externalSkillDir, 'SKILL.md'), '# External Skill\nexternal copy\n', 'utf-8')
    await writeFile(join(externalDupeDir, 'SKILL.md'), '# External Dupe\nexternal duplicate\n', 'utf-8')

    mockGetProfileDir.mockReturnValue(profileDir)
    mockReadConfigYamlForProfile.mockResolvedValue({
      skills: { external_dirs: [externalDir] },
    })

    try {
      const { list } = await loadController()
      const ctx: any = { state: { profile: { name: 'research' } }, body: null }

      await list(ctx)

      const tools = ctx.body.categories.find((category: any) => category.name === 'tools')
      expect(tools.skills).toEqual([
        expect.objectContaining({ name: 'dupe-skill', source: 'local', description: 'local copy' }),
        expect.objectContaining({ name: 'external-skill', source: 'external', description: 'external copy' }),
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('lists flat symlinked skills in the misc category', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-symlink-flat-skill-'))
    const profileDir = join(root, 'profile')
    const profileSkillsDir = join(profileDir, 'skills')
    const sharedSkillDir = join(root, 'shared-skills', 'linked-flat-skill')

    await mkdir(profileSkillsDir, { recursive: true })
    await mkdir(sharedSkillDir, { recursive: true })
    await writeFile(join(sharedSkillDir, 'SKILL.md'), '# Linked Flat Skill\nflat symlink copy\n', 'utf-8')
    await symlink(sharedSkillDir, join(profileSkillsDir, 'linked-flat-skill'))

    mockGetProfileDir.mockReturnValue(profileDir)

    try {
      const { list } = await loadController()
      const ctx: any = { state: { profile: { name: 'research' } }, body: null }

      await list(ctx)

      expect(ctx.body.categories).toContainEqual(expect.objectContaining({
        name: 'misc',
        skills: [
          expect.objectContaining({
            name: 'linked-flat-skill',
            source: 'local',
            description: 'flat symlink copy',
          }),
        ],
      }))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('lists Codex user and system skills for the codex target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-codex-skills-'))
    const previousHome = process.env.HOME
    const previousUserProfile = process.env.USERPROFILE
    const userSkillDir = join(root, '.agents', 'skills', 'user-skill')
    const systemSkillDir = join(root, '.codex', 'skills', '.system', 'system-skill')

    await mkdir(userSkillDir, { recursive: true })
    await mkdir(systemSkillDir, { recursive: true })
    await writeFile(join(userSkillDir, 'SKILL.md'), '# User Skill\nuser codex skill\n', 'utf-8')
    await writeFile(join(systemSkillDir, 'SKILL.md'), '# System Skill\nsystem codex skill\n', 'utf-8')
    process.env.HOME = root
    process.env.USERPROFILE = root

    try {
      const { list } = await loadController()
      const ctx: any = { query: { target: 'codex' }, state: { profile: { name: 'research' } }, body: null }

      await list(ctx)

      const misc = ctx.body.categories.find((category: any) => category.name === 'misc')
      expect(misc.skills).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'user-skill', source: 'local', description: 'user codex skill' }),
        expect.objectContaining({ name: 'system-skill', source: 'builtin', description: 'system codex skill' }),
      ]))
      expect(ctx.body.paths).toEqual({
        local: join(root, '.agents', 'skills'),
        external: [join(root, '.codex', 'skills', '.system')],
      })
      expect(mockReadConfigYamlForProfile).not.toHaveBeenCalled()
    } finally {
      if (previousHome == null) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousUserProfile == null) delete process.env.USERPROFILE
      else process.env.USERPROFILE = previousUserProfile
      await rm(root, { recursive: true, force: true })
    }
  })

  it('lists shared user skills without Codex system skills for the pi target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-pi-skills-'))
    const previousHome = process.env.HOME
    const previousUserProfile = process.env.USERPROFILE
    const userSkillDir = join(root, '.agents', 'skills', 'pi-user-skill')
    const systemSkillDir = join(root, '.codex', 'skills', '.system', 'codex-only-skill')

    await mkdir(userSkillDir, { recursive: true })
    await mkdir(systemSkillDir, { recursive: true })
    await writeFile(join(userSkillDir, 'SKILL.md'), '# Pi User Skill\nshared agent skill\n', 'utf-8')
    await writeFile(join(systemSkillDir, 'SKILL.md'), '# Codex Only\nmust not be exposed to Pi\n', 'utf-8')
    process.env.HOME = root
    process.env.USERPROFILE = root

    try {
      const { list } = await loadController()
      const ctx: any = { query: { target: 'pi' }, state: { profile: { name: 'research' } }, body: null }

      await list(ctx)

      const misc = ctx.body.categories.find((category: any) => category.name === 'misc')
      expect(misc.skills).toEqual([
        expect.objectContaining({ name: 'pi-user-skill', source: 'local', description: 'shared agent skill' }),
      ])
      expect(ctx.body.paths).toEqual({
        local: join(root, '.agents', 'skills'),
        external: [],
      })
      expect(mockReadConfigYamlForProfile).not.toHaveBeenCalled()
    } finally {
      if (previousHome == null) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousUserProfile == null) delete process.env.USERPROFILE
      else process.env.USERPROFILE = previousUserProfile
      await rm(root, { recursive: true, force: true })
    }
  })

  it('lists Grok shared agent skills as local skills', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-grok-skills-'))
    const previousHome = process.env.HOME
    const previousUserProfile = process.env.USERPROFILE
    const grokSkillDir = join(root, '.grok', 'skills', 'grok-skill')
    const sharedSkillDir = join(root, '.agents', 'skills', 'shared-skill')

    await mkdir(grokSkillDir, { recursive: true })
    await mkdir(sharedSkillDir, { recursive: true })
    await writeFile(join(grokSkillDir, 'SKILL.md'), '# Grok Skill\ngrok-local skill\n', 'utf-8')
    await writeFile(join(sharedSkillDir, 'SKILL.md'), '# Shared Skill\nshared agent skill\n', 'utf-8')
    process.env.HOME = root
    process.env.USERPROFILE = root

    try {
      const { list } = await loadController()
      const ctx: any = { query: { target: 'grok' }, state: { profile: { name: 'research' } }, body: null }

      await list(ctx)

      const misc = ctx.body.categories.find((category: any) => category.name === 'misc')
      expect(misc.skills).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'grok-skill', source: 'local', description: 'grok-local skill' }),
        expect.objectContaining({ name: 'shared-skill', source: 'local', description: 'shared agent skill' }),
      ]))
    } finally {
      if (previousHome == null) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousUserProfile == null) delete process.env.USERPROFILE
      else process.env.USERPROFILE = previousUserProfile
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects edits to Grok skills from the shared agent skills directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-grok-shared-skill-update-'))
    const previousHome = process.env.HOME
    const previousUserProfile = process.env.USERPROFILE
    const sharedSkillDir = join(root, '.agents', 'skills', 'shared-skill')

    await mkdir(sharedSkillDir, { recursive: true })
    await writeFile(join(sharedSkillDir, 'SKILL.md'), '# Shared Skill\nbefore\n', 'utf-8')
    process.env.HOME = root
    process.env.USERPROFILE = root

    try {
      const { updateSkill } = await loadController()
      const ctx: any = {
        query: { target: 'grok' },
        params: { category: 'misc', skill: 'shared-skill' },
        request: { body: { content: '# Shared Skill\nafter\n' } },
        state: { profile: { name: 'research' } },
        body: null,
      }

      await updateSkill(ctx)

      expect(ctx.status).toBe(403)
      expect(await readFile(join(sharedSkillDir, 'SKILL.md'), 'utf-8')).toBe('# Shared Skill\nbefore\n')
    } finally {
      if (previousHome == null) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousUserProfile == null) delete process.env.USERPROFILE
      else process.env.USERPROFILE = previousUserProfile
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reads OpenCode skills from the configured Coding Agent global home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-opencode-skills-'))
    const previousGlobalHome = process.env.HERMES_CODING_AGENT_GLOBAL_HOME
    const skillsDir = join(root, '.config', 'opencode', 'skills')
    const skillDir = join(skillsDir, 'demo-skill')
    const sharedSkillsDir = join(root, '.agents', 'skills')
    const sharedSkillDir = join(sharedSkillsDir, 'shared-skill')

    await mkdir(skillDir, { recursive: true })
    await mkdir(sharedSkillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '# Demo Skill\nOpenCode skill\n', 'utf-8')
    await writeFile(join(sharedSkillDir, 'SKILL.md'), '# Shared Skill\nShared OpenCode skill\n', 'utf-8')
    process.env.HERMES_CODING_AGENT_GLOBAL_HOME = root

    try {
      const { list } = await loadController()
      const target = { target: 'opencode' }

      const listCtx: any = {
        query: target,
        state: { profile: { name: 'research' } },
        body: null,
      }
      await list(listCtx)
      expect(listCtx.body.paths).toEqual({ local: skillsDir, external: [sharedSkillsDir] })
      expect(listCtx.body.categories).toContainEqual(expect.objectContaining({
        name: 'misc',
        skills: expect.arrayContaining([
          expect.objectContaining({
            name: 'demo-skill',
            enabled: true,
            source: 'local',
          }),
          expect.objectContaining({
            name: 'shared-skill',
            enabled: true,
            source: 'local',
          }),
        ]),
      }))
      expect(mockUpdateConfigYamlForProfile).not.toHaveBeenCalled()
    } finally {
      if (previousGlobalHome == null) delete process.env.HERMES_CODING_AGENT_GLOBAL_HOME
      else process.env.HERMES_CODING_AGENT_GLOBAL_HOME = previousGlobalHome
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reads Codex system skill details for the codex target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-codex-system-skill-'))
    const previousHome = process.env.HOME
    const previousUserProfile = process.env.USERPROFILE
    const systemSkillDir = join(root, '.codex', 'skills', '.system', 'imagegen')

    await mkdir(join(systemSkillDir, 'references'), { recursive: true })
    await writeFile(join(systemSkillDir, 'SKILL.md'), '# Imagegen\nsystem image skill\n', 'utf-8')
    await writeFile(join(systemSkillDir, 'references', 'usage.md'), 'usage notes\n', 'utf-8')
    process.env.HOME = root
    process.env.USERPROFILE = root
    mockListFilesRecursive.mockResolvedValue([
      { path: 'SKILL.md', isDir: false },
      { path: 'references/usage.md', isDir: false },
    ])

    try {
      const { readFile_, listFiles } = await loadController()
      const readCtx: any = {
        query: { target: 'codex' },
        params: { path: 'misc/imagegen/SKILL.md' },
        state: { profile: { name: 'research' } },
        body: null,
      }

      await readFile_(readCtx)

      expect(readCtx.body).toEqual({ content: '# Imagegen\nsystem image skill\n' })

      const filesCtx: any = {
        query: { target: 'codex' },
        params: { category: 'misc', skill: 'imagegen' },
        state: { profile: { name: 'research' } },
        body: null,
      }

      await listFiles(filesCtx)

      expect(filesCtx.body).toEqual({ files: [{ path: 'references/usage.md', isDir: false }] })
    } finally {
      if (previousHome == null) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousUserProfile == null) delete process.env.USERPROFILE
      else process.env.USERPROFILE = previousUserProfile
      await rm(root, { recursive: true, force: true })
    }
  })

  it('traverses symlinked category entries without following hidden or cyclic links', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-symlink-category-skill-'))
    const profileDir = join(root, 'profile')
    const toolsDir = join(profileDir, 'skills', 'tools')
    const linkedSkillDir = join(root, 'shared-skills', 'linked-skill')
    const linkedCategoryDir = join(root, 'shared-skills', 'linked-category')

    await mkdir(toolsDir, { recursive: true })
    await mkdir(linkedSkillDir, { recursive: true })
    await mkdir(linkedCategoryDir, { recursive: true })
    await writeFile(join(toolsDir, 'DESCRIPTION.md'), '# Tools\n', 'utf-8')
    await writeFile(join(linkedSkillDir, 'SKILL.md'), '# Linked Skill\nlinked skill copy\n', 'utf-8')
    await writeFile(join(linkedCategoryDir, 'SKILL.md'), '# Linked Category Skill\nlinked category copy\n', 'utf-8')
    await symlink(linkedSkillDir, join(toolsDir, 'linked-skill'))
    await symlink(linkedCategoryDir, join(toolsDir, 'linked-group'))
    await symlink(toolsDir, join(toolsDir, 'loop'))
    await symlink(linkedSkillDir, join(toolsDir, '.hidden-skill'))

    mockGetProfileDir.mockReturnValue(profileDir)

    try {
      const { list } = await loadController()
      const ctx: any = { state: { profile: { name: 'research' } }, body: null }

      await list(ctx)

      const tools = ctx.body.categories.find((category: any) => category.name === 'tools')
      expect(tools.skills).toEqual([
        expect.objectContaining({ name: 'linked-group', description: 'linked category copy', source: 'local' }),
        expect.objectContaining({ name: 'linked-skill', description: 'linked skill copy', source: 'local' }),
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('updates external skill directories in the request-scoped profile config', async () => {
    let updatedConfig: Record<string, any> | undefined
    mockUpdateConfigYamlForProfile.mockImplementation(async (_profile: string, updater: (config: Record<string, any>) => Record<string, any>) => {
      updatedConfig = await updater({ skills: { disabled: ['old-skill'] }, model: { default: 'glm-5.1' } })
      return undefined
    })
    const { updateExternalDirs } = await loadController()
    const ctx: any = {
      request: { body: { dirs: [' ~/research-skills ', '', '~/research-skills', '$HOME/shared-skills'] } },
      state: { profile: { name: 'research' } },
      body: null,
    }

    await updateExternalDirs(ctx)

    expect(mockUpdateConfigYamlForProfile).toHaveBeenCalledWith('research', expect.any(Function))
    expect(updatedConfig).toEqual({
      skills: { disabled: ['old-skill'], external_dirs: ['~/research-skills', '$HOME/shared-skills'] },
      model: { default: 'glm-5.1' },
    })
    expect(ctx.body).toEqual({ success: true, dirs: ['~/research-skills', '$HOME/shared-skills'] })
  })

  it('imports skills into the request-scoped profile directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-import-profile-'))
    const defaultProfileDir = join(root, 'default')
    const researchProfileDir = join(root, 'research')
    mockGetProfileDir.mockImplementation((profile: string) => profile === 'research' ? researchProfileDir : defaultProfileDir)

    const boundary = '----hermes-skill-import-test'
    const ctx: any = {
      get: vi.fn((header: string) => header.toLowerCase() === 'content-type' ? `multipart/form-data; boundary=${boundary}` : ''),
      req: Readable.from([multipartBody(boundary, [
        { name: 'file', filename: 'demo-skill/SKILL.md', contentType: 'text/markdown', value: '# Demo Skill\nresearch copy\n' },
      ])]),
      state: { profile: { name: 'research' } },
      body: null,
    }

    try {
      const { importSkill } = await loadController()

      await importSkill(ctx)

      await expect(readFile(join(researchProfileDir, 'skills', 'demo-skill', 'SKILL.md'), 'utf-8')).resolves.toBe('# Demo Skill\nresearch copy\n')
      await expect(readFile(join(defaultProfileDir, 'skills', 'demo-skill', 'SKILL.md'), 'utf-8')).rejects.toThrow()
      expect(ctx.body).toEqual({ success: true, name: 'demo-skill' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('returns bad request for malformed encoded skill import filenames', async () => {
    const boundary = '----hermes-skill-import-bad-filename'
    const ctx: any = {
      get: vi.fn((header: string) => header.toLowerCase() === 'content-type' ? `multipart/form-data; boundary=${boundary}` : ''),
      req: Readable.from([multipartBody(boundary, [
        { name: 'file', filenameStar: '%E0%A4%A', contentType: 'text/markdown', value: '# Demo Skill\n' },
      ])]),
      state: { profile: { name: 'research' } },
      body: null,
    }

    const { importSkill } = await loadController()

    await importSkill(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'Invalid multipart filename encoding' })
  })

  it('imports skills with valid encoded multipart filenames', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-import-encoded-filename-'))
    const profileDir = join(root, 'research')
    mockGetProfileDir.mockReturnValue(profileDir)

    const boundary = '----hermes-skill-import-encoded-filename'
    const ctx: any = {
      get: vi.fn((header: string) => header.toLowerCase() === 'content-type' ? `multipart/form-data; boundary=${boundary}` : ''),
      req: Readable.from([multipartBody(boundary, [
        { name: 'file', filenameStar: 'demo-skill%2FSKILL.md', contentType: 'text/markdown', value: '# Demo Skill\nencoded filename\n' },
      ])]),
      state: { profile: { name: 'research' } },
      body: null,
    }

    try {
      const { importSkill } = await loadController()

      await importSkill(ctx)

      await expect(readFile(join(profileDir, 'skills', 'demo-skill', 'SKILL.md'), 'utf-8')).resolves.toBe('# Demo Skill\nencoded filename\n')
      expect(ctx.body).toEqual({ success: true, name: 'demo-skill' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('deletes local skills only from the request-scoped profile directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-delete-profile-'))
    const defaultProfileDir = join(root, 'default')
    const researchProfileDir = join(root, 'research')
    const defaultSkillDir = join(defaultProfileDir, 'skills', 'tools', 'dupe-skill')
    const researchSkillDir = join(researchProfileDir, 'skills', 'tools', 'dupe-skill')
    await mkdir(defaultSkillDir, { recursive: true })
    await mkdir(researchSkillDir, { recursive: true })
    await writeFile(join(defaultSkillDir, 'SKILL.md'), '# Default Copy\n', 'utf-8')
    await writeFile(join(researchSkillDir, 'SKILL.md'), '# Research Copy\n', 'utf-8')
    mockGetProfileDir.mockImplementation((profile: string) => profile === 'research' ? researchProfileDir : defaultProfileDir)

    const ctx: any = {
      params: { category: 'tools', skill: 'dupe-skill' },
      state: { profile: { name: 'research' } },
      body: null,
    }

    try {
      const { deleteSkill } = await loadController()

      await deleteSkill(ctx)

      await expect(readFile(join(defaultSkillDir, 'SKILL.md'), 'utf-8')).resolves.toBe('# Default Copy\n')
      await expect(readFile(join(researchSkillDir, 'SKILL.md'), 'utf-8')).rejects.toThrow()
      expect(ctx.body).toEqual({ success: true })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('updates local skill content in the request-scoped profile directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-update-skill-'))
    const defaultProfileDir = join(root, 'default')
    const researchProfileDir = join(root, 'research')
    const defaultSkillDir = join(defaultProfileDir, 'skills', 'tools', 'dupe-skill')
    const researchSkillDir = join(researchProfileDir, 'skills', 'tools', 'dupe-skill')
    await mkdir(defaultSkillDir, { recursive: true })
    await mkdir(researchSkillDir, { recursive: true })
    await writeFile(join(defaultSkillDir, 'SKILL.md'), '# Default Copy\n', 'utf-8')
    await writeFile(join(researchSkillDir, 'SKILL.md'), '# Research Copy\n', 'utf-8')
    mockGetProfileDir.mockImplementation((profile: string) => profile === 'research' ? researchProfileDir : defaultProfileDir)

    const ctx: any = {
      query: {},
      params: { category: 'tools', skill: 'dupe-skill' },
      request: { body: { content: '# Updated Research Copy\n' } },
      state: { profile: { name: 'research' } },
      body: null,
    }

    try {
      const { updateSkill } = await loadController()

      await updateSkill(ctx)

      await expect(readFile(join(defaultSkillDir, 'SKILL.md'), 'utf-8')).resolves.toBe('# Default Copy\n')
      await expect(readFile(join(researchSkillDir, 'SKILL.md'), 'utf-8')).resolves.toBe('# Updated Research Copy\n')
      expect(ctx.body).toEqual({ success: true })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps Codex shared and system skills read-only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-web-ui-update-codex-skill-'))
    const previousHome = process.env.HOME
    const previousUserProfile = process.env.USERPROFILE
    const userSkillDir = join(root, '.agents', 'skills', 'user-skill')
    const systemSkillDir = join(root, '.codex', 'skills', '.system', 'system-skill')

    await mkdir(userSkillDir, { recursive: true })
    await mkdir(systemSkillDir, { recursive: true })
    await writeFile(join(userSkillDir, 'SKILL.md'), '# User Skill\n', 'utf-8')
    await writeFile(join(systemSkillDir, 'SKILL.md'), '# System Skill\n', 'utf-8')
    process.env.HOME = root
    process.env.USERPROFILE = root

    try {
      const { updateSkill } = await loadController()
      const userCtx: any = {
        query: { target: 'codex' },
        params: { category: 'misc', skill: 'user-skill' },
        request: { body: { content: '# Updated User Skill\n' } },
        state: { profile: { name: 'research' } },
        body: null,
      }

      await updateSkill(userCtx)

      await expect(readFile(join(userSkillDir, 'SKILL.md'), 'utf-8')).resolves.toBe('# User Skill\n')
      expect(userCtx.status).toBe(403)

      const systemCtx: any = {
        query: { target: 'codex' },
        params: { category: 'misc', skill: 'system-skill' },
        request: { body: { content: '# Updated System Skill\n' } },
        state: { profile: { name: 'research' } },
        body: null,
      }

      await updateSkill(systemCtx)

      await expect(readFile(join(systemSkillDir, 'SKILL.md'), 'utf-8')).resolves.toBe('# System Skill\n')
      expect(systemCtx.status).toBe(404)
      expect(systemCtx.body).toEqual({ error: 'Skill not found' })
    } finally {
      if (previousHome == null) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousUserProfile == null) delete process.env.USERPROFILE
      else process.env.USERPROFILE = previousUserProfile
      await rm(root, { recursive: true, force: true })
    }
  })
})
