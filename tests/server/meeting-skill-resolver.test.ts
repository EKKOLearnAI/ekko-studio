import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tempDirs: string[] = []
const originalHermesHome = process.env.HERMES_HOME
const originalSkillsDir = process.env.HERMES_WEB_UI_SKILLS_DIR

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** 写一个带 frontmatter 的 SKILL.md。 */
async function writeSkill(skillDir: string, frontmatter: string, body: string): Promise<void> {
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), `---\n${frontmatter}---\n\n${body}\n`, 'utf-8')
}

beforeEach(async () => {
  await import('../../packages/server/src/bootstrap/agent-profile-adapter')
  await import('../../packages/server/src/bootstrap/meeting-runtime-adapter')
})

afterEach(async () => {
  vi.resetModules()
  if (originalHermesHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = originalHermesHome
  if (originalSkillsDir === undefined) delete process.env.HERMES_WEB_UI_SKILLS_DIR
  else process.env.HERMES_WEB_UI_SKILLS_DIR = originalSkillsDir
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('meeting skill-resolver', () => {
  it('buildSkillInstructionsSection returns empty for no skills and joins bodies otherwise', async () => {
    const { buildSkillInstructionsSection } = await import('../../packages/server/src/modules/studio/services/meeting-asr/skill-resolver')

    expect(buildSkillInstructionsSection([])).toBe('')

    const section = buildSkillInstructionsSection([
      { name: 'meeting-analysis', description: '', instructions: '# 方法论 A', tags: ['meeting'] },
      { name: 'meeting-notes', description: '', instructions: '# 方法论 B', tags: ['meeting'] },
    ])
    expect(section).toContain('分析技能')
    expect(section).toContain('技能：meeting-analysis')
    expect(section).toContain('# 方法论 A')
    expect(section).toContain('技能：meeting-notes')
    expect(section).toContain('# 方法论 B')
  })

  it('loadAnalysisSkills keeps only meeting-related skills and respects the disabled list', async () => {
    const hermesHome = await tempDir('meeting-skill-home-')
    process.env.HERMES_HOME = hermesHome

    const skillsDir = join(hermesHome, 'skills')
    await writeSkill(join(skillsDir, 'meeting-analysis'), 'name: meeting-analysis\ntags: [meeting, analysis]\n', '内置会议分析方法论')
    await writeSkill(join(skillsDir, 'custom-meeting-notes'), 'name: custom-meeting-notes\n', '自定义会议笔记方法')
    await writeSkill(join(skillsDir, 'image-gen'), 'name: image-gen\ntags: [image]\n', '图像生成，与会议无关')

    // 禁用 custom-meeting-notes
    await writeFile(join(hermesHome, 'config.yaml'), 'skills:\n  disabled:\n    - custom-meeting-notes\n', 'utf-8')

    const { loadAnalysisSkills } = await import('../../packages/server/src/modules/studio/services/meeting-asr/skill-resolver')
    const skills = await loadAnalysisSkills('default')

    expect(skills.map(s => s.name)).toEqual(['meeting-analysis'])
    expect(skills[0].instructions).toContain('内置会议分析方法论')
  })

  it('ensureMeetingAnalysisSkill auto-installs the bundled skill when missing', async () => {
    const source = await tempDir('meeting-skill-source-')
    const hermesHome = await tempDir('meeting-skill-home-')
    process.env.HERMES_WEB_UI_SKILLS_DIR = source
    process.env.HERMES_HOME = hermesHome

    await writeSkill(join(source, 'meeting-analysis'), 'name: meeting-analysis\ntags: [meeting]\n', '内置技能正文')

    const { ensureMeetingAnalysisSkill } = await import('../../packages/server/src/modules/studio/services/meeting-asr/skill-resolver')
    await ensureMeetingAnalysisSkill('default')

    const installed = join(hermesHome, 'skills', 'meeting-analysis', 'SKILL.md')
    expect(existsSync(installed)).toBe(true)
    expect(await readFile(installed, 'utf-8')).toContain('内置技能正文')
  })

  it('prepareAnalysisSkillSection auto-installs then returns an injectable prompt section', async () => {
    const source = await tempDir('meeting-skill-source-')
    const hermesHome = await tempDir('meeting-skill-home-')
    process.env.HERMES_WEB_UI_SKILLS_DIR = source
    process.env.HERMES_HOME = hermesHome

    await writeSkill(join(source, 'meeting-analysis'), 'name: meeting-analysis\ntags: [meeting]\n', '报告结构方法论')

    const { prepareAnalysisSkillSection } = await import('../../packages/server/src/modules/studio/services/meeting-asr/skill-resolver')
    const section = await prepareAnalysisSkillSection('default')

    expect(section).toContain('分析技能')
    expect(section).toContain('报告结构方法论')
  })

  it('prepareAnalysisSkillSection targets a named profile directory', async () => {
    const source = await tempDir('meeting-skill-source-')
    const hermesHome = await tempDir('meeting-skill-home-')
    process.env.HERMES_WEB_UI_SKILLS_DIR = source
    process.env.HERMES_HOME = hermesHome

    await mkdir(join(hermesHome, 'profiles', 'alpha'), { recursive: true })
    await writeSkill(join(source, 'meeting-analysis'), 'name: meeting-analysis\ntags: [meeting]\n', '命名 profile 技能')

    const { prepareAnalysisSkillSection } = await import('../../packages/server/src/modules/studio/services/meeting-asr/skill-resolver')
    const section = await prepareAnalysisSkillSection('alpha')

    expect(section).toContain('命名 profile 技能')
    expect(existsSync(join(hermesHome, 'profiles', 'alpha', 'skills', 'meeting-analysis', 'SKILL.md'))).toBe(true)
  })
})
