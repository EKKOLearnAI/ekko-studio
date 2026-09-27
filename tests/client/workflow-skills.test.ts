import { describe, expect, it } from 'vitest'
import { buildWorkflowSkillOptions, workflowAgentToSkillTarget } from '@/utils/hermes/workflow-skills'

describe('workflow skill helpers', () => {
  it('maps workflow agents to skill API targets', () => {
    expect(workflowAgentToSkillTarget('hermes')).toBe('hermes')
    expect(workflowAgentToSkillTarget('ekko-agent')).toBe('hermes')
    expect(workflowAgentToSkillTarget('claude-code')).toBe('claude')
    expect(workflowAgentToSkillTarget('codex')).toBe('codex')
    expect(workflowAgentToSkillTarget('pi')).toBe('pi')
    expect(workflowAgentToSkillTarget('dsh')).toBe('dsh')
    expect(workflowAgentToSkillTarget('cursor')).toBe('cursor')
    expect(workflowAgentToSkillTarget('unknown-agent')).toBe('hermes')
  })

  it('builds sorted enabled skill options without duplicate names', () => {
    expect(buildWorkflowSkillOptions({
      archived: [],
      categories: [
        {
          name: 'beta',
          description: '',
          skills: [
            { name: 'write-report', description: '', enabled: true },
            { name: 'disabled-skill', description: '', enabled: false },
          ],
        },
        {
          name: 'alpha',
          description: '',
          skills: [
            { name: 'analyze-data', description: '' },
            { name: 'write-report', description: '' },
          ],
        },
      ],
    })).toEqual([
      { label: 'analyze-data', value: 'analyze-data' },
      { label: 'write-report', value: 'write-report' },
    ])
  })
})
