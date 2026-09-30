import type { BrowserObservation, BrowserSnapshotNode } from './browser-types'
import { redactBrowserContent } from './browser-url'

export interface BrowserObservedState {
  url: string
  nodes: Map<number, BrowserSnapshotNode>
}

export interface BrowserObservedTarget {
  nodeId: number
  actionIndex: number
  text?: string
}

function signature(node: BrowserSnapshotNode | undefined): string {
  if (!node) return ''
  const { ref: _ref, focused: _focused, ...state } = node
  return JSON.stringify(state)
}

export function observeBrowserState(
  before: BrowserObservedState | undefined,
  after: BrowserObservedState,
  targets: BrowserObservedTarget[],
): BrowserObservation {
  const changes: NonNullable<BrowserObservation['changes']> = []
  if (before) {
    for (const id of new Set([...before.nodes.keys(), ...after.nodes.keys()])) {
      const previous = before.nodes.get(id), current = after.nodes.get(id)
      if (signature(previous) !== signature(current)) changes.push({ before: previous, after: current })
    }
  }
  // Put control state ahead of decorative/structural changes in the bounded evidence.
  const stateChanged = (change: typeof changes[number]) => ['value', 'checked', 'selected', 'pressed', 'expanded']
    .some(key => change.before?.[key as keyof BrowserSnapshotNode] !== change.after?.[key as keyof BrowserSnapshotNode])
  changes.sort((a, b) => Number(stateChanged(b)) - Number(stateChanged(a)))
  const targetStates = [...new Map(targets.map(target => [target.nodeId, target])).values()].slice(-12).map(target => {
    const previous = before?.nodes.get(target.nodeId), current = after.nodes.get(target.nodeId)
    // A redacted/truncated value cannot establish equality. Never expose protected input values.
    const comparable = target.text !== undefined && target.text.length < 500 && typeof current?.value === 'string'
      && current.value.length < 500 && redactBrowserContent(target.text, 500) === target.text && !/\[redacted\]/i.test(current.value)
    return { before: previous, after: current, ...(comparable ? { valueMatches: current!.value === target.text } : {}) }
  })
  const changed = before ? changes.length > 0 || before.url !== after.url : undefined
  return {
    status: 'observed', ...(changed !== undefined ? { changed } : {}), changeCount: changes.length,
    changes: changes.slice(0, 12), targets: targetStates,
    hint: changed === false
      ? 'Action dispatched, but no page/control change was observed. Do not repeat the same click blindly; inspect the target state or refresh the relevant region. This does not prove failure or success.'
      : 'Action dispatched. Check target values/selection and changed text to confirm the intended outcome; dispatch or a page change alone does not prove success.',
  }
}
