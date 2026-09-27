import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  getProfileDir: (profile: string) => `/tmp/hermes-${profile}`,
  readConfigYamlForProfile: async () => ({}),
  safeReadFile: async (path: string) => {
    try {
      return await readFile(path, 'utf-8')
    } catch {
      return null
    }
  },
}))

const originalGlobalHome = process.env.HERMES_CODING_AGENT_GLOBAL_HOME

afterEach(() => {
  if (originalGlobalHome == null) delete process.env.HERMES_CODING_AGENT_GLOBAL_HOME
  else process.env.HERMES_CODING_AGENT_GLOBAL_HOME = originalGlobalHome
})

describe('workflow Coding Agent skill roots', () => {
  it('resolves Cursor private and shared skills without consulting the Hermes profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studio-workflow-cursor-skills-'))
    process.env.HERMES_CODING_AGENT_GLOBAL_HOME = root
    try {
      for (const [path, content] of [
        ['.cursor/skills/category/release/SKILL.md', 'Cursor private'],
        ['.agents/skills/release/SKILL.md', 'Shared duplicate'],
        ['.agents/skills/shared-only/SKILL.md', 'Shared only'],
      ]) {
        await mkdir(join(root, path, '..'), { recursive: true })
        await writeFile(join(root, path), content)
      }
      const { resolveWorkflowSkillContent } = await import('../../packages/server/src/modules/studio/services/workflow/skill-resolver')
      await expect(resolveWorkflowSkillContent({ agent: 'cursor', profile: 'default', skillName: 'release' }))
        .resolves.toMatchObject({ target: 'cursor', content: 'Cursor private' })
      await expect(resolveWorkflowSkillContent({ agent: 'cursor', profile: 'default', skillName: 'shared-only' }))
        .resolves.toMatchObject({ target: 'cursor', content: 'Shared only' })
      await expect(resolveWorkflowSkillContent({ agent: 'cursor', profile: 'default', skillName: 'missing' })).resolves.toBeNull()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('resolves DSH direct bundles and flat shared skills without falling back to Codex or nested categories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studio-workflow-dsh-skills-'))
    process.env.HERMES_CODING_AGENT_GLOBAL_HOME = root
    try {
      for (const [path, content] of [
        ['.dsh/skills/direct/SKILL.md', 'DSH bundle'], ['.agents/skills/shared.md', 'Shared flat skill'],
        ['.dsh/skills/custom_file.md', 'Skill filename may differ from its frontmatter name'],
        ['.dsh/skills/category/nested/SKILL.md', 'Nested'], ['.codex/skills/.system/codex-only/SKILL.md', 'Codex'],
      ]) {
        const parts = path.split('/')
        await mkdir(join(root, ...parts.slice(0, -1)), { recursive: true })
        await writeFile(join(root, path), content)
      }
      const { resolveWorkflowSkillContent } = await import('../../packages/server/src/modules/studio/services/workflow/skill-resolver')
      const resolve = (skillName: string) => resolveWorkflowSkillContent({ agent: 'dsh', profile: 'default', skillName })
      await expect(resolve('direct')).resolves.toMatchObject({ target: 'dsh', content: 'DSH bundle' })
      await expect(resolve('shared')).resolves.toMatchObject({ target: 'dsh', content: 'Shared flat skill' })
      await expect(resolve('custom_file')).resolves.toMatchObject({ target: 'dsh', content: 'Skill filename may differ from its frontmatter name' })
      for (const name of ['nested', 'codex-only', '../shared']) await expect(resolve(name)).resolves.toBeNull()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('resolves OpenCode skills from the authoritative global home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-workflow-opencode-skills-'))
    const skillDir = join(root, '.config', 'opencode', 'skills', 'release-notes')
    process.env.HERMES_CODING_AGENT_GLOBAL_HOME = root
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '# Release notes\nOpenCode workflow skill.\n', 'utf-8')

    try {
      const { resolveWorkflowSkillContent } = await import(
        '../../packages/server/src/modules/studio/services/workflow/skill-resolver'
      )
      await expect(resolveWorkflowSkillContent({
        agent: 'opencode',
        profile: 'default',
        skillName: 'release-notes',
      })).resolves.toEqual({
        name: 'release-notes',
        target: 'opencode',
        path: join(skillDir, 'SKILL.md'),
        content: '# Release notes\nOpenCode workflow skill.\n',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves OpenCode skills from the shared agent skills directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-workflow-opencode-shared-skills-'))
    const skillDir = join(root, '.agents', 'skills', 'release-notes')
    process.env.HERMES_CODING_AGENT_GLOBAL_HOME = root
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '# Release notes\nShared OpenCode workflow skill.\n', 'utf-8')

    try {
      const { resolveWorkflowSkillContent } = await import(
        '../../packages/server/src/modules/studio/services/workflow/skill-resolver'
      )
      await expect(resolveWorkflowSkillContent({
        agent: 'opencode',
        profile: 'default',
        skillName: 'release-notes',
      })).resolves.toEqual({
        name: 'release-notes',
        target: 'opencode',
        path: join(skillDir, 'SKILL.md'),
        content: '# Release notes\nShared OpenCode workflow skill.\n',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
