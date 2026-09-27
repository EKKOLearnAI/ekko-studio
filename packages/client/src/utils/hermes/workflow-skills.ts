import type { SkillInfo, SkillTarget, SkillsData } from '@/api/hermes/skills'
import type { WorkflowSelectOption } from '@/components/hermes/workflow/types'

export function workflowAgentToSkillTarget(agent: string): SkillTarget {
  if (agent === 'cursor') return 'cursor'
  if (agent === 'claude-code') return 'claude'
  if (agent === 'codex') return 'codex'
  if (agent === 'pi') return 'pi'
  if (agent === 'grok') return 'grok'
  if (agent === 'dsh') return 'dsh'
  if (agent === 'opencode') return 'opencode'
  return 'hermes'
}

export function buildWorkflowSkillOptions(data: SkillsData): WorkflowSelectOption[] {
  const byName = new Map<string, SkillInfo>()
  for (const category of data.categories || []) {
    for (const skill of category.skills || []) {
      if (skill.enabled === false) continue
      if (!byName.has(skill.name)) byName.set(skill.name, skill)
    }
  }
  return [...byName.values()]
    .map(skill => ({ label: skill.name, value: skill.name }))
    .sort((a, b) => a.label.localeCompare(b.label))
}
