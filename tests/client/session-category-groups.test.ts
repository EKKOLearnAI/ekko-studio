import { describe, expect, it } from 'vitest'

import {
  buildRecentSessionCategoryGroup,
  buildVisibleSessionCategoryGroups,
  partitionRecentSessions,
} from '../../packages/client/src/components/hermes/chat/session-category-groups'

describe('session category groups', () => {
  it('keeps categories that have no visible sessions', () => {
    const groups = buildVisibleSessionCategoryGroups(
      [
        { id: 1, name: 'Work' },
        { id: 2, name: 'Empty' },
      ],
      [
        { id: 'session-1', categoryId: 1 },
        { id: 'session-2', categoryId: null },
      ],
      'Uncategorized',
    )

    expect(groups.map((group) => [group.key, group.sessions.length, group.categoryId])).toEqual([
      ['category-1', 1, 1],
      ['category-2', 0, 2],
      ['category-none', 1, undefined],
    ])
  })

  it('shows every category but no Uncategorized group when the session list is empty', () => {
    expect(buildVisibleSessionCategoryGroups(
      [{ id: 1, name: 'Work' }],
      [],
      'Uncategorized',
    )).toEqual([{ key: 'category-1', label: 'Work', sessions: [], categoryId: 1 }])
    expect(buildVisibleSessionCategoryGroups([], [], 'Uncategorized')).toEqual([])
  })

  it('shows sessions with deleted or unknown categories as uncategorized', () => {
    const groups = buildVisibleSessionCategoryGroups(
      [{ id: 1, name: 'Work' }],
      [{ id: 'session-1', categoryId: 999 }],
      'Uncategorized',
    )

    expect(groups).toEqual([{ key: 'category-1', label: 'Work', sessions: [], categoryId: 1 }, {
      key: 'category-none',
      label: 'Uncategorized',
      sessions: [{ id: 'session-1', categoryId: 999 }],
    }])
  })

  it('builds a dynamic recent group by strict activity time without changing real categories', () => {
    const sessions = [
      { id: 'older', categoryId: 1, updatedAt: 100 },
      { id: 'newest', categoryId: null, updatedAt: 300 },
      { id: 'middle', categoryId: 2, updatedAt: 200 },
    ]

    expect(buildRecentSessionCategoryGroup(sessions, 2, 'Recent')).toEqual({
      key: 'recent',
      label: 'Recent',
      sessions: [sessions[1], sessions[2]],
    })
    expect(sessions.map(session => session.categoryId)).toEqual([1, null, 2])
  })

  it('keeps recent sessions in their sidebar categories', () => {
    const sessions = [
      { id: 'older-pinned', categoryId: 1, updatedAt: 100 },
      { id: 'newest-categorized', categoryId: 1, updatedAt: 300 },
      { id: 'middle-uncategorized', categoryId: null, updatedAt: 200 },
    ]

    const partition = partitionRecentSessions(sessions, 2, 'Recent')
    const otherGroups = buildVisibleSessionCategoryGroups(
      [{ id: 1, name: 'Work' }],
      partition.remaining,
      'Uncategorized',
    )

    expect(partition.group.sessions.map(session => session.id)).toEqual([
      'newest-categorized',
      'middle-uncategorized',
    ])
    expect(otherGroups.flatMap(group => group.sessions.map(session => session.id))).toEqual([
      'older-pinned',
      'newest-categorized',
      'middle-uncategorized',
    ])
  })
})
