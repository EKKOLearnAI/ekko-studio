import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SkillListTool,
  SkillViewTool,
  createDefaultToolRegistry,
  inspectLocalSkillValidationIssues,
  matchSkillsForUserMessage,
} from '../../packages/ekko-agent/src'

let root = ''
let skillDirectory = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ekko-agent-skills-'))
  skillDirectory = join(root, 'profile-skills')
  await mkdir(join(skillDirectory, 'writing', 'release-notes'), { recursive: true })
  await mkdir(join(skillDirectory, 'local-only'), { recursive: true })
  await writeFile(
    join(skillDirectory, 'writing', 'release-notes', 'SKILL.md'),
    '---\nname: release-notes\ndescription: "Write polished release summaries."\nmetadata:\n  keywords:\n    - release summary\n---\n# Release Notes\nLocal instructions.\n',
  )
  await writeFile(
    join(skillDirectory, 'local-only', 'SKILL.md'),
    '# Local Only\nUse local guidance.\n',
  )
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('ekko-agent skill tools', () => {
  it('returns empty successful results when the agent has no configured skill directory', async () => {
    expect(createDefaultToolRegistry().get('skill_manage')).toBeUndefined()
    const listResult = await new SkillListTool().execute({})
    expect(listResult.ok).toBe(true)
    expect(JSON.parse(listResult.content)).toMatchObject({
      count: 0,
      total: 0,
      skills: [],
    })

    await expect(new SkillViewTool().execute({ name: 'anything' })).resolves.toEqual({
      ok: true,
      content: '',
    })
  })

  it('lists skills only from the directory bound at tool construction', async () => {
    const otherSkills = join(root, 'other-skills')
    await mkdir(join(otherSkills, 'not-visible'), { recursive: true })
    await writeFile(join(otherSkills, 'not-visible', 'SKILL.md'), '# Hidden\nOutside the configured directory.\n')

    const result = await new SkillListTool(skillDirectory).execute({})
    const payload = JSON.parse(result.content)

    expect(payload.skills).toEqual([
      {
        name: 'local-only', description: 'Use local guidance.', category: 'misc', source: 'local', enabled: true,
        managedByEkko: false, builtIn: false, validationStatus: 'invalid',
        validationError: 'SKILL.md must start with YAML frontmatter.',
      },
      {
        name: 'release-notes', description: 'Write polished release summaries.', category: 'writing', source: 'local', enabled: true,
        managedByEkko: false, builtIn: false, validationStatus: 'valid',
      },
    ])
    expect(payload.total).toBe(2)
  })

  it('searches skill names and descriptions without exposing a result limit', async () => {
    const tool = new SkillListTool(skillDirectory)
    const result = await tool.execute({ query: 'write' })
    const payload = JSON.parse(result.content)

    expect(tool.definition.parameters.properties).not.toHaveProperty('limit')
    expect(payload.query).toBe('write')
    expect(payload.count).toBe(1)
    expect(payload.skills).toEqual([
      {
        name: 'release-notes', description: 'Write polished release summaries.', category: 'writing', source: 'local', enabled: true,
        managedByEkko: false, builtIn: false, validationStatus: 'valid',
      },
    ])
  })

  it('flags third-party Skills that install without deterministic keyword metadata', async () => {
    const directory = join(skillDirectory, 'dashi-ppt')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'SKILL.md'), [
      '---',
      'name: dashi-ppt',
      'description: Create presentation decks.',
      '---',
      '# Dashi PPT',
      'Create a deck.',
      '',
    ].join('\n'))

    await expect(inspectLocalSkillValidationIssues(skillDirectory)).resolves.toContainEqual(
      expect.objectContaining({
        name: 'dashi-ppt',
        status: 'needs_metadata',
        error: expect.stringContaining('metadata.keywords'),
        directory: await realpath(directory),
      }),
    )
    const listed = await new SkillListTool(skillDirectory).execute({ query: 'dashi-ppt' })
    expect(listed.data).toMatchObject({
      skills: [{ name: 'dashi-ppt', validationStatus: 'needs_metadata' }],
    })
  })

  it.each(['\n', '\r\n'].flatMap(newline =>
    [[], [''], [' \t '], ['', ' \t ', '']].map(blankLines => ({ newline, blankLines })),
  ))('preserves indented descriptions without consuming the next key (%j)', async ({ newline, blankLines }) => {
    const directory = join(skillDirectory, 'blank-description')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'SKILL.md'), [
      '---',
      'name: blank-description',
      'description: \t',
      ...blankLines,
      'metadata:',
      '  keywords: [blank description]',
      '---',
      '# Blank Description',
      'Body guidance.',
      '',
    ].join(newline))

    await expect(inspectLocalSkillValidationIssues(skillDirectory)).resolves.toContainEqual(
      expect.objectContaining({
        name: 'blank-description',
        status: 'invalid',
        error: 'SKILL.md frontmatter requires a description.',
      }),
    )
    const listed = await new SkillListTool(skillDirectory).execute({ query: 'blank-description' })
    expect(listed.data).toMatchObject({
      skills: [{ name: 'blank-description', description: 'Body guidance.', validationStatus: 'invalid' }],
    })
    await expect(matchSkillsForUserMessage(skillDirectory, 'blank description')).resolves.toEqual([])

    const indented = join(skillDirectory, 'indented-description')
    await mkdir(indented, { recursive: true })
    await writeFile(join(indented, 'SKILL.md'), [
      '---',
      'name: indented-description',
      'description: \t',
      ...blankLines,
      '  Indented guidance.',
      'metadata:',
      '  keywords: [indented description]',
      '---',
      '# Indented Description',
      'Body guidance.',
      '',
    ].join(newline))
    const indentedListed = await new SkillListTool(skillDirectory).execute({ query: 'indented-description' })
    expect(indentedListed.data).toMatchObject({
      skills: [{ name: 'indented-description', description: 'Indented guidance.', validationStatus: 'valid' }],
    })
    await expect(matchSkillsForUserMessage(skillDirectory, 'indented description')).resolves.toMatchObject([
      { name: 'indented-description' },
    ])
  })

  it('hard-matches only skill names and maintained keywords', async () => {
    await expect(matchSkillsForUserMessage(skillDirectory, 'Please prepare a release summary.')).resolves.toMatchObject([
      { name: 'release-notes' },
    ])
    await expect(matchSkillsForUserMessage(skillDirectory, '请帮我整理一份发布说明')).resolves.toEqual([])
    await expect(matchSkillsForUserMessage(skillDirectory, 'Please write polished notes.')).resolves.toEqual([])
    await expect(matchSkillsForUserMessage(skillDirectory, 'Use release notes for this change.')).resolves.toMatchObject([
      { name: 'release-notes' },
    ])
  })

  it('returns every discovered skill when the directory contains more than the old default limit', async () => {
    await Promise.all(Array.from({ length: 55 }, async (_, index) => {
      const name = `bulk-skill-${String(index).padStart(2, '0')}`
      const directory = join(skillDirectory, name)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'SKILL.md'), `# ${name}\nBulk skill ${index}.\n`)
    }))

    const result = await new SkillListTool(skillDirectory).execute({})
    const payload = JSON.parse(result.content)

    expect(payload.count).toBe(57)
    expect(payload.total).toBe(57)
    expect(payload.skills).toHaveLength(57)
  })

  it('loads the main skill file when filePath is omitted, empty, or an explicit SKILL.md alias', async () => {
    const tool = new SkillViewTool(skillDirectory)
    const expectedBaseDirectory = await realpath(join(skillDirectory, 'writing', 'release-notes'))
    for (const filePath of [undefined, '', 'SKILL.md', './SKILL.md', '.\\SKILL.md']) {
      const result = await tool.execute({
        name: 'release-notes',
        ...(filePath === undefined ? {} : { filePath }),
      })

      expect(result.ok).toBe(true)
      expect(result.content).toMatch(/^\[skill_view\] name=release-notes \(\d+ chars\) file=SKILL\.md/)
      expect(result.content).toMatch(/\bsha256=[a-f0-9]{64}\b/)
      expect(result.content).toContain(`baseDirectory=${expectedBaseDirectory}`)
      expect(result.data).toMatchObject({
        baseDirectory: expectedBaseDirectory,
      })
      expect(result.content).toContain('Local instructions.')
    }
  })

  it('does not resolve path-like skill names outside the configured directory', async () => {
    const tool = new SkillViewTool(skillDirectory)

    await expect(tool.execute({ name: '../release-notes' })).resolves.toMatchObject({ ok: false })
  })

  it('does not follow cyclic directory symlinks forever', async () => {
    const category = join(skillDirectory, 'cyclic')
    await mkdir(category, { recursive: true })
    await symlink(category, join(category, 'loop'))

    const result = await new SkillListTool(skillDirectory).execute({})

    expect(result.ok).toBe(true)
  })

  it('creates and patches an Ekko-managed skill with a recoverable backup', async () => {
    const tools = createDefaultToolRegistry({ skillDirectory })
    expect(tools.get('skill_manage')).toBeDefined()
    const runContext = { runId: 'skill-run', skillMutationSource: 'foreground' as const }
    const content = [
      '---',
      'name: durable-debugging',
      'description: Preserve reusable debugging procedures.',
      'metadata:',
      '  keywords:',
      '    - durable debugging',
      '---',
      '# Durable Debugging',
      '## Procedure',
      'Run the focused test.',
      '',
    ].join('\n')

    await expect(tools.execute('skill_manage', {
      action: 'create',
      name: 'durable-debugging',
      content,
      category: 'engineering',
    }, runContext)).resolves.toMatchObject({ ok: true })

    const view = await tools.execute('skill_view', { name: 'durable-debugging' }, runContext)
    expect(view).toMatchObject({
      ok: true,
      data: {
        managedByEkko: true,
      },
    })

    const patch = await tools.execute('skill_manage', {
      action: 'patch',
      name: 'durable-debugging',
      oldString: 'Run the focused test.',
      newString: 'Run the focused test, then verify the regression.',
    }, runContext)

    expect(patch).toMatchObject({ ok: true })
    await expect(readFile(
      join(skillDirectory, 'engineering', 'durable-debugging', 'SKILL.md'),
      'utf8',
    )).resolves.toContain('then verify the regression')
    expect(await readdir(join(skillDirectory, '.ekko-backups'))).toHaveLength(1)

    const secondPatchWithoutReview = await tools.execute('skill_manage', {
      action: 'patch',
      name: 'durable-debugging',
      oldString: 'then verify the regression',
      newString: 'then verify every regression',
    }, runContext)
    expect(secondPatchWithoutReview).toMatchObject({ ok: false })
    expect(secondPatchWithoutReview.content).toContain('skill_view')
  })

  it('requires creator-managed skills to maintain a non-empty keyword list', async () => {
    const tools = createDefaultToolRegistry({ skillDirectory })
    const result = await tools.execute('skill_manage', {
      action: 'create',
      name: 'missing-keywords',
      content: [
        '---',
        'name: missing-keywords',
        'description: Missing deterministic routing metadata.',
        '---',
        '# Missing keywords',
        'Instructions.',
      ].join('\n'),
    }, { runId: 'missing-keywords', skillMutationSource: 'foreground' })

    expect(result).toMatchObject({ ok: false })
    expect(result.content).toContain('requires at least one non-empty metadata.keywords entry')
  })

  it('requires creator-managed routing keywords to remain compact English ASCII', async () => {
    const tools = createDefaultToolRegistry({ skillDirectory })
    const result = await tools.execute('skill_manage', {
      action: 'create',
      name: 'localized-keywords',
      content: [
        '---',
        'name: localized-keywords',
        'description: Reject translated host routing metadata.',
        'metadata:',
        '  keywords:',
        '    - weather lookup',
        '    - 天气查询',
        '---',
        '# Localized keywords',
        'Instructions.',
      ].join('\n'),
    }, { runId: 'localized-keywords', skillMutationSource: 'foreground' })

    expect(result).toMatchObject({ ok: false })
    expect(result.content).toContain('must use English ASCII text or technical identifiers')
  })

  it('requires a fresh same-run skill_view before overwriting existing content', async () => {
    const tools = createDefaultToolRegistry({ skillDirectory })
    const runContext = { runId: 'stale-run', skillMutationSource: 'foreground' as const }
    const skillPath = join(skillDirectory, 'writing', 'release-notes', 'SKILL.md')

    const unread = await tools.execute('skill_manage', {
      action: 'patch',
      name: 'release-notes',
      oldString: 'Local instructions.',
      newString: 'Updated instructions.',
    }, runContext)
    expect(unread).toMatchObject({ ok: false })
    expect(unread.content).toContain('skill_view')

    await tools.execute('skill_view', { name: 'release-notes' }, runContext)
    await writeFile(skillPath, `${await readFile(skillPath, 'utf8')}\nConcurrent change.\n`)
    const stale = await tools.execute('skill_manage', {
      action: 'patch',
      name: 'release-notes',
      oldString: 'Local instructions.',
      newString: 'Updated instructions.',
    }, runContext)
    expect(stale).toMatchObject({ ok: false })
    expect(stale.content).toContain('changed after skill_view')
  })

  it('keeps background review away from manually-authored skills', async () => {
    const tools = createDefaultToolRegistry({ skillDirectory })
    const reviewContext = { runId: 'review-run', skillMutationSource: 'background-review' as const }

    await tools.execute('skill_view', { name: 'release-notes' }, reviewContext)
    const result = await tools.execute('skill_manage', {
      action: 'patch',
      name: 'release-notes',
      oldString: 'Local instructions.',
      newString: 'Background rewrite.',
    }, reviewContext)

    expect(result).toMatchObject({ ok: false })
    expect(result.content).toContain('protected skill')
  })

  it('manages allowed support files with the same read-before-write guard', async () => {
    const tools = createDefaultToolRegistry({ skillDirectory })
    const runContext = { runId: 'support-run', skillMutationSource: 'foreground' as const }
    await tools.execute('skill_manage', {
      action: 'create',
      name: 'support-files',
      content: [
        '---',
        'name: support-files',
        'description: Keep reusable supporting material.',
        'metadata:',
        '  keywords:',
        '    - support files',
        '---',
        '# Support Files',
        'Read references/checklist.md.',
        '',
      ].join('\n'),
    }, runContext)

    await expect(tools.execute('skill_manage', {
      action: 'write_file',
      name: 'support-files',
      filePath: 'references/checklist.md',
      fileContent: 'Run the focused test.',
    }, runContext)).resolves.toMatchObject({ ok: true })

    const viewed = await tools.execute('skill_view', {
      name: 'support-files',
      filePath: 'references/checklist.md',
    }, runContext)
    expect(viewed.content).toMatch(/^\[skill_view\] name=support-files \(\d+ chars\) file=references\/checklist\.md/)

    await expect(tools.execute('skill_manage', {
      action: 'patch',
      name: 'support-files',
      filePath: 'references/checklist.md',
      oldString: 'focused test',
      newString: 'focused test and inspect its output',
    }, runContext)).resolves.toMatchObject({ ok: true })

    const unreadRemoval = await tools.execute('skill_manage', {
      action: 'remove_file',
      name: 'support-files',
      filePath: 'references/checklist.md',
    }, runContext)
    expect(unreadRemoval).toMatchObject({ ok: false })

    await tools.execute('skill_view', {
      name: 'support-files',
      filePath: 'references/checklist.md',
    }, runContext)
    await expect(tools.execute('skill_manage', {
      action: 'remove_file',
      name: 'support-files',
      filePath: 'references/checklist.md',
    }, runContext)).resolves.toMatchObject({ ok: true })
    await expect(readFile(
      join(skillDirectory, 'support-files', 'references', 'checklist.md'),
      'utf8',
    )).rejects.toThrow()
  })

  it('restricts support files and archives confirmed deletes instead of erasing them', async () => {
    const tools = createDefaultToolRegistry({ skillDirectory })
    const runContext = { runId: 'archive-run', skillMutationSource: 'foreground' as const }
    const content = [
      '---',
      'name: safe-skill',
      'description: Keep reusable safe procedures.',
      'metadata:',
      '  keywords:',
      '    - safe procedure',
      '---',
      '# Safe Skill',
      '## Procedure',
      'Verify the result.',
      '',
    ].join('\n')
    await tools.execute('skill_manage', {
      action: 'create',
      name: 'safe-skill',
      content,
    }, runContext)

    const escaped = await tools.execute('skill_manage', {
      action: 'write_file',
      name: 'safe-skill',
      filePath: '../outside.md',
      fileContent: 'outside',
    }, runContext)
    expect(escaped).toMatchObject({ ok: false })

    await tools.execute('skill_view', { name: 'safe-skill' }, runContext)
    const unconfirmed = await tools.execute('skill_manage', {
      action: 'delete',
      name: 'safe-skill',
    }, runContext)
    expect(unconfirmed).toMatchObject({ ok: false })
    expect(unconfirmed.content).toContain('confirmed=true')

    const archived = await tools.execute('skill_manage', {
      action: 'delete',
      name: 'safe-skill',
      confirmed: true,
    }, runContext)
    expect(archived).toMatchObject({
      ok: true,
      data: {
        archived: true,
      },
    })
    await expect(readFile(join(skillDirectory, 'safe-skill', 'SKILL.md'), 'utf8')).rejects.toThrow()
    expect(await readdir(join(skillDirectory, '.ekko-archive'))).toHaveLength(1)
  })

  it('does not discover a skill through a symlink that escapes the configured root', async () => {
    const outside = join(root, 'outside-skill')
    await mkdir(outside)
    await writeFile(join(outside, 'SKILL.md'), '# Outside\nMust stay hidden.\n')
    await symlink(outside, join(skillDirectory, 'escaped-skill'))

    const result = await new SkillListTool(skillDirectory).execute({})
    const payload = JSON.parse(result.content)

    expect(payload.skills.map((skill: { name: string }) => skill.name)).not.toContain('outside-skill')
  })

  it('discovers read-only external roots and excludes disabled Skills from routing', async () => {
    const externalRoot = join(root, 'shared-skills')
    await mkdir(join(externalRoot, 'research', 'shared-search'), { recursive: true })
    await writeFile(
      join(externalRoot, 'research', 'shared-search', 'SKILL.md'),
      '---\nname: shared-search\ndescription: Search shared sources.\nmetadata:\n  keywords:\n    - shared lookup\n---\n# Shared search\n',
    )
    const external = [{ directory: externalRoot, sourcePath: '~/shared-skills' }]
    const listed = await new SkillListTool(skillDirectory, external, ['release-notes']).execute({})
    const skills = (listed.data as { skills: Array<Record<string, unknown>> }).skills

    expect(skills).toContainEqual(expect.objectContaining({
      name: 'shared-search', category: 'research', source: 'external',
      sourcePath: '~/shared-skills', enabled: true,
    }))
    expect(skills).toContainEqual(expect.objectContaining({ name: 'release-notes', enabled: false }))
    await expect(matchSkillsForUserMessage(
      skillDirectory,
      'Please do a shared lookup.',
      external,
      ['shared-search'],
    )).resolves.toEqual([])
  })

  it('identifies built-ins from the Profile manifest and refuses to delete them', async () => {
    await writeFile(join(skillDirectory, '.ekko-builtin-skills.json'), JSON.stringify({
      'release-notes': { owner: 'ekko-agent', sourceHash: 'source', installedHash: 'installed' },
    }))
    const tools = createDefaultToolRegistry({ skillDirectory })
    const runContext = { runId: 'builtin-delete', skillMutationSource: 'foreground' as const }
    const listed = await tools.execute('skill_list', {}, runContext)
    expect((listed.data as { skills: Array<{ name: string; builtIn: boolean }> }).skills)
      .toContainEqual(expect.objectContaining({ name: 'release-notes', builtIn: true }))

    await tools.execute('skill_view', { name: 'release-notes' }, runContext)
    const deleted = await tools.execute('skill_manage', {
      action: 'delete',
      name: 'release-notes',
      confirmed: true,
    }, runContext)
    expect(deleted).toMatchObject({ ok: false })
    expect(deleted.content).toContain('Built-in skill cannot be deleted')
    await expect(readFile(join(skillDirectory, 'writing', 'release-notes', 'SKILL.md'), 'utf8'))
      .resolves.toContain('Local instructions.')
  })
})
