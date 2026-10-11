import { describe, expect, it } from 'vitest'
import {
  normalizeWorkflowRunEdge,
  normalizeWorkflowRunNodeTargets,
  workflowRunEdgeCanvasLabel,
  workflowRunNodeModelDetails,
} from '../../packages/client/src/utils/workflow-run-snapshot'

describe('Workflow run snapshot playback', () => {
  it('reads historical model configurations without replacing native or removed model IDs', () => {
    const nodes = [
      { id: 'hermes', data: { title: 'Historical Hermes', agent: 'hermes', provider: 'removed-provider', model: 'removed-model', reasoningEffort: 'high' } },
      { id: 'scoped', data: { agent: 'codex', agentMode: 'scoped', provider: 'custom:old', model: 'old-codex', reasoningEffort: 'xhigh' } },
      { id: 'global', data: { agent: 'codex', agentMode: 'global', model: 'native-old', reasoningEffort: 'ultra' } },
      { id: 'cursor', data: { agent: 'cursor', model: 'native-old-high', reasoningEffort: 'high' } },
    ]
    const original = structuredClone(nodes)
    expect(workflowRunNodeModelDetails(nodes)).toEqual([
      { id: 'hermes', title: 'Historical Hermes', agent: 'hermes', agentMode: 'scoped', provider: 'removed-provider', model: 'removed-model', reasoningEffort: 'high' },
      { id: 'scoped', title: 'scoped', agent: 'codex', agentMode: 'scoped', provider: 'custom:old', model: 'old-codex', reasoningEffort: 'xhigh' },
      { id: 'global', title: 'global', agent: 'codex', agentMode: 'global', provider: '', model: 'native-old', reasoningEffort: 'ultra' },
      { id: 'cursor', title: 'cursor', agent: 'cursor', agentMode: 'global', provider: '', model: 'native-old-high', reasoningEffort: 'high' },
    ])
    expect(nodes).toEqual(original)
  })

  it('distinguishes an explicit Agent default from unrecorded legacy model settings', () => {
    expect(workflowRunNodeModelDetails([
      null, [], {}, { id: 'other', type: 'note' },
      { id: 'default', type: 'agent', data: { agent: 'codex', agentMode: 'global', model: '', reasoningEffort: 'default' } },
      { id: 'legacy', data: { title: '  ', agent: 'codex', agentMode: 'global' } },
    ])).toEqual([
      { id: 'default', title: 'default', agent: 'codex', agentMode: 'global', provider: '', model: '', reasoningEffort: 'default' },
      { id: 'legacy', title: 'legacy', agent: 'codex', agentMode: 'global', provider: '', model: null, reasoningEffort: null },
    ])
  })

  it('preserves authored handles, labels, animation, and orchestration data', () => {
    expect(normalizeWorkflowRunEdge({
      id: 'review-retry',
      source: 'review',
      target: 'code',
      sourceHandle: 'bottom',
      targetHandle: 'bottom',
      label: 'RETRY',
      animated: true,
      data: {
        orchestration: {
          route: 'success',
          condition: { path: 'outputJson.decision', operator: 'equals', value: 'RETRY' },
          feedback: { maxIterations: 3, loopId: 'code-review' },
        },
      },
    })).toMatchObject({
      id: 'review-retry',
      sourceHandle: 'bottom',
      targetHandle: 'bottom',
      label: 'RETRY',
      animated: true,
      data: {
        orchestration: {
          condition: { path: 'outputJson.decision', operator: 'equals', value: 'RETRY' },
          feedback: { maxIterations: 3, loopId: 'code-review' },
        },
      },
    })
  })

  it('adapts legacy compiled-only orchestration without inventing missing handles', () => {
    expect(normalizeWorkflowRunEdge({
      id: 'legacy-review-retry',
      source: 'review',
      target: 'code',
      orchestration: {
        route: 'success',
        condition: { path: 'outputJson.decision', operator: 'equals', value: 'RETRY' },
        feedback: { maxIterations: 3, loopId: 'code-review' },
      },
    })).toMatchObject({
      id: 'legacy-review-retry',
      sourceHandle: 'output',
      targetHandle: 'input',
      data: {
        orchestration: {
          condition: { path: 'outputJson.decision', operator: 'equals', value: 'RETRY' },
          feedback: { maxIterations: 3, loopId: 'code-review' },
        },
      },
    })
  })

  it('does not rewrite frozen run targets when the current model catalog changes', () => {
    const frozen = [{ data: { provider: 'removed-provider', model: 'frozen-model', apiMode: 'chat_completions' } }]
    const normalizer = () => ({ provider: 'current-provider', model: 'fallback-model', apiMode: 'anthropic_messages' as const })

    expect(normalizeWorkflowRunNodeTargets(frozen, true, normalizer)).toEqual(frozen)
    expect(normalizeWorkflowRunNodeTargets(frozen, false, normalizer)[0]?.data).toMatchObject({
      provider: 'current-provider',
      model: 'fallback-model',
      apiMode: 'anthropic_messages',
    })
  })

  it('renders the frozen authored edge label for run playback', () => {
    expect(workflowRunEdgeCanvasLabel('RETRY', 'Decision equals RETRY', true)).toBe('RETRY')
    expect(workflowRunEdgeCanvasLabel(undefined, 'Decision equals RETRY', true)).toBe('Decision equals RETRY')
    expect(workflowRunEdgeCanvasLabel('RETRY', 'Decision equals RETRY', false)).toBe('Decision equals RETRY')
  })
})
