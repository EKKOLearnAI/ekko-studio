import { describe, expect, it } from 'vitest'
import {
  normalizeWorkflowRunEdge,
  normalizeWorkflowRunNodeTargets,
  workflowRunEdgeCanvasLabel,
} from '../../packages/client/src/utils/workflow-run-snapshot'

describe('Workflow run snapshot playback', () => {
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
