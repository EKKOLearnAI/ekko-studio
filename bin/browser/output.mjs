function snapshotOutput(snapshot, includeText) {
  if (includeText || !Array.isArray(snapshot?.nodes) || !snapshot.snapshotId) return snapshot
  const { text, ...result } = snapshot
  return result
}

/** Nodes preserve refs, rendered labels and state; the parallel text rendering duplicates them. */
export function browserOutput(envelope, includeText = false) {
  const result = snapshotOutput(envelope.result, includeText)
  return { content: [{ type: 'text', text: JSON.stringify({ ...envelope,
    result: result?.snapshot ? { ...result, snapshot: snapshotOutput(result.snapshot, includeText) } : result,
  }) }] }
}
