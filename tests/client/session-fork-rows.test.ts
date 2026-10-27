import { describe, expect, it } from 'vitest'

import { buildSessionForkRows } from '../../packages/client/src/components/hermes/chat/session-fork-rows'

interface TestSession {
  id: string
  parentSessionId?: string | null
  forkPointMessageId?: string | null
  endReason?: string | null
}

function session(id: string, overrides: Partial<TestSession> = {}): TestSession {
  return { id, ...overrides }
}

function fork(id: string, parentSessionId: string): TestSession {
  return session(id, { parentSessionId, forkPointMessageId: '42' })
}

describe('session fork rows', () => {
  it('nests direct fork children under their parent in sidebar order', () => {
    const sessions = [
      fork('newest-child', 'root'),
      session('root'),
      fork('older-child', 'root'),
      session('other'),
    ]

    const rows = buildSessionForkRows(sessions, new Set())

    expect(rows.map(row => [row.session.id, row.depth])).toEqual([
      ['root', 0],
      ['newest-child', 1],
      ['older-child', 1],
      ['other', 0],
    ])
    expect(rows[0]).toMatchObject({ childSessionCount: 2, childrenExpanded: true })
    expect(rows[0].session).toBe(sessions[1])
  })

  it('keeps the child count when collapsed and hides only direct children', () => {
    const rows = buildSessionForkRows([
      session('root'),
      fork('child', 'root'),
      session('other'),
    ], new Set(['root']))

    expect(rows.map(row => row.session.id)).toEqual(['root', 'other'])
    expect(rows[0]).toMatchObject({ childSessionCount: 1, childrenExpanded: false })
  })

  it('keeps orphan fork sessions visible as top-level rows', () => {
    const rows = buildSessionForkRows([
      fork('orphan', 'missing-parent'),
      session('other'),
    ], new Set())

    expect(rows.map(row => [row.session.id, row.depth, row.childSessionCount])).toEqual([
      ['orphan', 0, 0],
      ['other', 0, 0],
    ])
  })

  it('recognizes imported branches from the parent end reason', () => {
    const rows = buildSessionForkRows([
      session('root', { endReason: 'branched' }),
      session('imported-child', { parentSessionId: 'root' }),
    ], new Set())

    expect(rows.map(row => [row.session.id, row.depth])).toEqual([
      ['root', 0],
      ['imported-child', 1],
    ])
  })

  it('does not treat compression continuations as fork children', () => {
    const rows = buildSessionForkRows([
      session('root', { endReason: 'compression' }),
      session('continuation', { parentSessionId: 'root' }),
    ], new Set())

    expect(rows.map(row => [row.session.id, row.depth])).toEqual([
      ['root', 0],
      ['continuation', 0],
    ])
  })

  it('leaves grandchildren top-level instead of hiding them in the MVP tree', () => {
    const rows = buildSessionForkRows([
      session('root'),
      fork('child', 'root'),
      fork('grandchild', 'child'),
    ], new Set())

    expect(rows.map(row => [row.session.id, row.depth])).toEqual([
      ['root', 0],
      ['child', 1],
      ['grandchild', 0],
    ])
  })

  it('fails open for cyclic metadata instead of dropping sessions', () => {
    const rows = buildSessionForkRows([
      fork('a', 'b'),
      fork('b', 'a'),
    ], new Set())

    expect(rows.map(row => row.session.id)).toEqual(['a', 'b'])
    expect(rows.every(row => row.depth === 0)).toBe(true)
  })
})
