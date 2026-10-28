export interface SessionForkLike {
  id: string
  parentSessionId?: string | null
  forkPointMessageId?: string | null
  endReason?: string | null
}

export interface SessionForkRow<T extends SessionForkLike> {
  session: T
  depth: 0 | 1
  childSessionCount: number
  childrenExpanded: boolean
}

function isExplicitFork<T extends SessionForkLike>(session: T, parent: T | undefined): boolean {
  if (!parent || parent.id === session.id || session.parentSessionId !== parent.id) return false
  return Boolean(session.forkPointMessageId) || parent.endReason === 'branched'
}

/**
 * Build the sidebar's one-level fork projection without hiding sessions whose
 * parent is absent from the current category, pinned list, or recent slice.
 */
export function buildSessionForkRows<T extends SessionForkLike>(
  sessions: readonly T[],
  collapsedParentIds: ReadonlySet<string>,
): SessionForkRow<T>[] {
  const byId = new Map(sessions.map(session => [session.id, session]))
  const parentByChild = new Map<string, string>()

  for (const session of sessions) {
    const parent = session.parentSessionId ? byId.get(session.parentSessionId) : undefined
    if (parent && isExplicitFork(session, parent)) parentByChild.set(session.id, parent.id)
  }

  const childrenByParent = new Map<string, T[]>()
  for (const session of sessions) {
    const parentId = parentByChild.get(session.id)
    // The MVP renders one level. Keep deeper descendants top-level rather than
    // attaching them to a parent that is itself nested and hiding them.
    if (!parentId || parentByChild.has(parentId)) continue
    const children = childrenByParent.get(parentId) || []
    children.push(session)
    childrenByParent.set(parentId, children)
  }

  const nestedChildIds = new Set(
    [...childrenByParent.values()].flat().map(session => session.id),
  )
  const rows: SessionForkRow<T>[] = []

  for (const session of sessions) {
    if (nestedChildIds.has(session.id)) continue
    const children = childrenByParent.get(session.id) || []
    const childrenExpanded = children.length > 0 && !collapsedParentIds.has(session.id)
    rows.push({
      session,
      depth: 0,
      childSessionCount: children.length,
      childrenExpanded,
    })
    if (!childrenExpanded) continue
    for (const child of children) {
      rows.push({ session: child, depth: 1, childSessionCount: 0, childrenExpanded: false })
    }
  }

  return rows
}
