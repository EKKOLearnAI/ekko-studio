// Mark as unread in the session context menu, and a check that every locale names the action and its failure.
import type { DropdownOption } from 'naive-ui'
import type { VNode } from 'vue'
import { describe, expect, it } from 'vitest'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildSessionContextMenuOptions } from '@/components/hermes/chat/session-menu-options'

function describeOptions(options: DropdownOption[]) {
  return options.map((option) => {
    const item = option as DropdownOption & {
      icon?: () => VNode
      label?: string
      type?: string
    }
    const icon = item.icon?.()
    return {
      key: item.key,
      label: item.label,
      icon: icon?.props?.['data-session-menu-icon'],
      hasChildren: Array.isArray(item.children),
    }
  })
}

describe('Mark as unread menu action', () => {
  it('offers Mark as unread after pinning when the conversation can be marked', () => {
    const options = buildSessionContextMenuOptions({
      pinned: false,
      includeArchive: false,
      includeModel: false,
      includeMarkUnread: true,
      categoryChildren: [],
      labels: {
        pin: 'Pin',
        unpin: 'Unpin',
        markUnread: 'Mark as unread',
        rename: 'Rename',
        archive: 'Archive',
        workspace: 'Set Workspace',
        model: 'Set Model',
        category: 'Move to category',
        export: 'Export',
        exportFull: 'Full Export (JSON)',
        exportCompressed: 'Compressed Export (TXT)',
        open: 'Open in new tab',
        copyLink: 'Copy Session Link',
        copyId: 'Copy Session ID',
      },
    })

    expect(describeOptions(options).slice(0, 3)).toEqual([
      { key: 'pin', label: 'Pin', icon: 'pin', hasChildren: false },
      { key: 'mark-unread', label: 'Mark as unread', icon: 'unread', hasChildren: false },
      { key: 'rename', label: 'Rename', icon: 'rename', hasChildren: false },
    ])
  })

  it('stays out of the default context menu', () => {
    const options = buildSessionContextMenuOptions({
      pinned: true, includeArchive: false, includeModel: false, categoryChildren: [],
      labels: { pin: 'Pin', unpin: 'Unpin', rename: 'Rename', archive: 'Archive', workspace: 'Set Workspace', model: 'Set Model',
        category: 'Move to category', export: 'Export', exportFull: 'Full Export (JSON)', exportCompressed: 'Compressed Export (TXT)',
        open: 'Open in new tab', copyLink: 'Copy Session Link', copyId: 'Copy Session ID' },
    })
    expect(options.map(option => option.key)).not.toContain('mark-unread')
  })

  it('is translated in every locale', async () => {
    const dir = resolve(__dirname, '../../packages/client/src/i18n/locales')
    const locales = readdirSync(dir).filter(name => name.endsWith('.ts'))
    expect(locales.length).toBeGreaterThan(1)
    for (const name of locales) {
      const messages = (await import(resolve(dir, name))).default as { chat?: Record<string, unknown> }
      expect(typeof messages.chat?.markUnread, name).toBe('string')
      expect(typeof messages.chat?.markUnreadFailed, name).toBe('string')
    }
  })
})
