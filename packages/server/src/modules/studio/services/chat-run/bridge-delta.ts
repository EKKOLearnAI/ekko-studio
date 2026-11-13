import { filterToolCallMarkup, flushToolCallMarkup, type ToolCallMarkupState } from '../../../../../../shared/tool-call-markup'

export interface BridgeDeltaFilterState {
  bridgePendingToolCallMarkup?: string
  bridgeXmlMarkup?: ToolCallMarkupState
}

const TOOL_CALL_MARKER = '[Calling tool:'
const MAX_PENDING_TOOL_MARKUP_LENGTH = 100_000

/**
 * Flush any partial-prefix that was held back waiting to see if it would
 * become a `[Calling tool: ...]` marker. Call this when the streaming
 * context guarantees no marker can follow (e.g. on `tool.started`,
 * `tool.completed`, run completion, run failure, abort).
 *
 * Without this, deltas that legitimately end with `[`, `[C`, `[Ca`, ...,
 * `[Calling tool` are silently dropped from the user-visible stream
 * because the filter expected the buffered chars to either complete the
 * marker (and be discarded) or be released by a follow-up delta — but
 * follow-up deltas don't always come for the SAME assistant message.
 *
 * Returns the buffered text so callers can forward it to the client as
 * a regular `message.delta` payload.
 */
export function flushPendingToolCallMarkup(state: BridgeDeltaFilterState): string {
  const pending = state.bridgePendingToolCallMarkup || ''
  state.bridgePendingToolCallMarkup = ''
  const xmlPending = state.bridgeXmlMarkup ? flushToolCallMarkup(state.bridgeXmlMarkup) : ''
  return pending + xmlPending
}

function findToolMarkupEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '[') {
      depth += 1
      continue
    }
    if (ch === ']') {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }

  return -1
}

function trailingMarkerPrefixLength(text: string): number {
  const max = Math.min(text.length, TOOL_CALL_MARKER.length - 1)
  for (let len = max; len > 0; len -= 1) {
    if (TOOL_CALL_MARKER.startsWith(text.slice(text.length - len))) return len
  }
  return 0
}

export function filterBridgeToolCallMarkupDelta(
  state: BridgeDeltaFilterState,
  delta: string,
): string {
  if (!delta) return ''

  state.bridgeXmlMarkup ||= {}
  delta = filterToolCallMarkup(state.bridgeXmlMarkup, delta)
  const text = `${state.bridgePendingToolCallMarkup || ''}${delta}`
  state.bridgePendingToolCallMarkup = ''

  let out = ''
  let idx = 0
  while (idx < text.length) {
    const markerIdx = text.indexOf(TOOL_CALL_MARKER, idx)
    if (markerIdx < 0) {
      const rest = text.slice(idx)
      const pendingPrefixLength = trailingMarkerPrefixLength(rest)
      if (pendingPrefixLength > 0) {
        out += rest.slice(0, rest.length - pendingPrefixLength)
        state.bridgePendingToolCallMarkup = rest.slice(rest.length - pendingPrefixLength)
      } else {
        out += rest
      }
      break
    }

    out += text.slice(idx, markerIdx)
    const end = findToolMarkupEnd(text, markerIdx)
    if (end < 0) {
      state.bridgePendingToolCallMarkup = text.slice(markerIdx)
      if (state.bridgePendingToolCallMarkup.length > MAX_PENDING_TOOL_MARKUP_LENGTH) {
        state.bridgePendingToolCallMarkup = ''
      }
      break
    }

    idx = end
    if (text[idx] === '\r' && text[idx + 1] === '\n') {
      idx += 2
    } else if (text[idx] === '\n') {
      idx += 1
    }
  }

  return out
}
