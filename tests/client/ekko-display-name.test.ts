import { readFileSync, readdirSync } from 'node:fs'
import { extname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AGENT_OPTIONS, GROUP_AGENT_OPTIONS } from '../../packages/client/src/utils/agent-options'

function clientSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return clientSourceFiles(path)
    return ['.ts', '.vue'].includes(extname(entry.name)) ? [path] : []
  })
}

describe('Ekko display name', () => {
  it('uses Ekko everywhere in the client without changing the internal runtime id', () => {
    const occurrences = clientSourceFiles('packages/client/src')
      .flatMap(path => readFileSync(path, 'utf8').includes('Ekko Agent') ? [path] : [])

    expect(occurrences).toEqual([])
    expect(AGENT_OPTIONS).toContainEqual({ label: 'Ekko', value: 'ekko-agent' })
    expect(GROUP_AGENT_OPTIONS).toContainEqual({ label: 'Ekko', value: 'ekko' })
  })

  it.each([
    ['single chat', 'packages/client/src/components/hermes/chat/ChatPanel.vue',
      AGENT_OPTIONS, 'AGENT_OPTIONS', 'const newChatAgentOptions = computed(() => AGENT_OPTIONS.map('],
    ['group chat', 'packages/client/src/components/hermes/group-chat/GroupChatPanel.vue',
      GROUP_AGENT_OPTIONS, 'GROUP_AGENT_OPTIONS', 'const groupAgentTypeDefinitions = GROUP_AGENT_OPTIONS'],
    ['group chat link', 'packages/client/src/views/hermes/GroupChatLinkView.vue',
      GROUP_AGENT_OPTIONS, 'GROUP_AGENT_OPTIONS', 'const groupAgentTypeDefinitions = GROUP_AGENT_OPTIONS'],
    ['workflow', 'packages/client/src/views/hermes/WorkflowView.vue',
      AGENT_OPTIONS, 'AGENT_OPTIONS', 'const workflowAgentDefinitions = AGENT_OPTIONS'],
  ] as const)('uses the shared order with Ekko second in the %s Agent dropdown', (_name, path, options, exportName, binding) => {
    const source = readFileSync(path, 'utf8')

    expect(source).toMatch(new RegExp(`import\\s+\\{\\s*${exportName}\\s*\\}\\s+from\\s+['"]@/utils/agent-options['"]`))
    expect(source).toContain(binding)
    expect(options.map(option => option.label)).toEqual([
      'Hermes', 'Ekko', 'Claude', 'Codex', 'Pi', 'Grok', 'OpenCode', 'DeepSeek Harness', 'Cursor', 'Antigravity',
    ])
  })

  it('keeps server-managed provider choices available for Ekko workflow nodes', () => {
    const view = readFileSync('packages/client/src/views/hermes/WorkflowView.vue', 'utf8')
    const node = readFileSync('packages/client/src/components/hermes/workflow/WorkflowAgentNode.vue', 'utf8')

    expect(view).toContain('canScopedCodingAgentUseProvider(')
    expect(node).toContain('canScopedCodingAgentUseProvider(')
  })

  it('keeps the log API id internal while displaying Ekko', () => {
    const logs = readFileSync('packages/client/src/views/hermes/LogsView.vue', 'utf8')

    expect(logs).toContain("name.replace(/^ekko-agent(?=\\/|$)/, 'Ekko')")
    expect(logs).toContain('`${displayLogName(f.name)} (${f.size})`')
    expect(logs).toContain('{{ displayLogName(entry.logger) }}')
  })

  it('uses Claude everywhere in the client without changing the internal runtime id', () => {
    const occurrences = clientSourceFiles('packages/client/src')
      .flatMap(path => readFileSync(path, 'utf8').includes('Claude Code') ? [path] : [])

    expect(occurrences).toEqual([])
    expect(AGENT_OPTIONS).toContainEqual({ label: 'Claude', value: 'claude-code' })
    expect(GROUP_AGENT_OPTIONS).toContainEqual({ label: 'Claude', value: 'claude' })
  })
})
