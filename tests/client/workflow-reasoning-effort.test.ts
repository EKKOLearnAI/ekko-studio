import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(path, 'utf8')
const locales = ['de.ts', 'en.ts', 'es.ts', 'fr.ts', 'ja.ts', 'ko.ts', 'pt.ts', 'ru.ts', 'zh-TW.ts', 'zh.ts']

describe('workflow reasoning effort authoring contract', () => {
  it('preserves reasoning effort through node editing, loading, and serialization', () => {
    const types = read('packages/client/src/components/hermes/workflow/types.ts')
    const node = read('packages/client/src/components/hermes/workflow/WorkflowAgentNode.vue')
    const view = read('packages/client/src/views/hermes/WorkflowView.vue')
    expect(types).toMatch(/reasoningEffort:\s*string/)
    expect(types).toMatch(/WorkflowAgentNodeEditableData[^\n]+reasoningEffort/)
    expect(node).toContain(':value="data.reasoningEffort"')
    expect(node).toContain("updateField('reasoningEffort'")
    expect(view).toContain("reasoningEffort: data.reasoningEffort || 'default'")
    expect(view).toContain('reasoningEffort: node.data.reasoningEffort')
    expect(view).toContain("reasoningEffort: typeof data.reasoningEffort === 'string'")
  })

  it('offers every canonical reasoning effort in every locale', () => {
    const node = read('packages/client/src/components/hermes/workflow/WorkflowAgentNode.vue')
    for (const effort of ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      expect(node).toContain(`value: '${effort}'`)
    }
    for (const locale of locales) {
      const text = read(`packages/client/src/i18n/locales/${locale}`)
      expect(text, locale).toMatch(/reasoningEffort:\s*\{/)
      expect(text, locale).toMatch(/max:\s*['"]/)
    }
  })
  it('supports global CLI mode for Claude, Codex, Pi, and Grok workflow nodes', () => {
    const types = read('packages/client/src/components/hermes/workflow/types.ts')
    const node = read('packages/client/src/components/hermes/workflow/WorkflowAgentNode.vue')
    const view = read('packages/client/src/views/hermes/WorkflowView.vue')
    expect(types).toMatch(/agentMode:\s*'scoped' \| 'global'/)
    expect(node).toContain("['claude-code', 'codex', 'pi', 'grok', 'opencode', 'dsh', 'cursor'].includes(props.data.agent)")
    expect(node).toContain("updateField('agentMode'")
    expect(node).toContain('v-if="usesScopedModel"')
    expect(view).toContain('agentMode: node.data.agentMode')
    expect(view).toContain('nextCodingAgentMode({')
    expect(view).toContain('agentMode: switched.agentMode')
    expect(view).toContain('priorAgentMode: switched.priorAgentMode')
  })
  it('keeps Workflow nodes aligned with upstream defaults instead of exposing execution-policy controls', () => {
    const types = read('packages/client/src/components/hermes/workflow/types.ts')
    const node = read('packages/client/src/components/hermes/workflow/WorkflowAgentNode.vue')
    const view = read('packages/client/src/views/hermes/WorkflowView.vue')
    for (const removed of ['executionPolicy', 'allowedToolsets', 'allowedTools', 'skipMemory', 'skipContextFiles']) {
      expect(types).not.toContain(removed)
      expect(node).not.toContain(removed)
      expect(view).not.toContain(removed)
    }
    for (const locale of locales) {
      const text = read(`packages/client/src/i18n/locales/${locale}`)
      for (const removed of ['allowedToolsets', 'allowedTools', 'skipMemory', 'skipContextFiles']) {
        expect(text, locale).not.toContain(removed)
      }
    }
  })

})
