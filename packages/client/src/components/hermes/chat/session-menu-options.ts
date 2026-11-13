import type { DropdownOption } from 'naive-ui'
import { h, type VNode, type VNodeChild } from 'vue'

export type SessionMenuIconName =
  | 'outline'
  | 'pin'
  | 'rename'
  | 'archive'
  | 'workspace'
  | 'model'
  | 'category'
  | 'export'
  | 'open-new'
  | 'link'
  | 'copy'

interface ActiveSessionMenuLabels {
  outline: string
  rename: string
  open: string
  copyId: string
  /** Offered only for sessions that can receive scheduled cron result notices. */
  cronConsentSetup?: string
}

interface ActiveSessionMenuAvailability {
  canRename: boolean
  canOpen: boolean
  canCronConsentSetup?: boolean
}

interface SessionContextMenuLabels {
  pin: string
  unpin: string
  rename: string
  archive: string
  workspace: string
  model: string
  category: string
  export: string
  exportFull: string
  exportCompressed: string
  open: string
  copyLink: string
  copyId: string
}

interface BuildSessionContextMenuOptions {
  pinned: boolean
  includeArchive: boolean
  includeModel: boolean
  categoryChildren: DropdownOption[]
  labels: SessionContextMenuLabels
}

function iconChildren(name: SessionMenuIconName): VNodeChild[] {
  switch (name) {
    case 'outline':
      return [
        h('circle', { cx: 5, cy: 6, r: 1 }),
        h('circle', { cx: 5, cy: 12, r: 1 }),
        h('circle', { cx: 5, cy: 18, r: 1 }),
        h('path', { d: 'M9 6h10M9 12h10M9 18h10' }),
      ]
    case 'pin':
      return [
        h('path', { d: 'M8 4h8' }),
        h('path', { d: 'M9 4v6l-2 4v2h10v-2l-2-4V4' }),
        h('path', { d: 'M12 16v5' }),
      ]
    case 'rename':
      return [
        h('path', { d: 'M12 20h9' }),
        h('path', { d: 'M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4z' }),
      ]
    case 'archive':
      return [
        h('rect', { x: 3, y: 4, width: 18, height: 5, rx: 1 }),
        h('path', { d: 'M5 9v11h14V9M10 13h4' }),
      ]
    case 'workspace':
      return [
        h('path', { d: 'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }),
      ]
    case 'model':
      return [
        h('path', { d: 'm12 3 1.4 4.1L17.5 9l-4.1 1.4L12 14.5l-1.4-4.1L6.5 9l4.1-1.4z' }),
        h('path', { d: 'm18.5 15 .7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7z' }),
      ]
    case 'category':
      return [
        h('path', { d: 'M4 4h6l10 10-6 6L4 10z' }),
        h('circle', { cx: 8.5, cy: 8.5, r: 1 }),
      ]
    case 'export':
      return [
        h('path', { d: 'M12 3v11' }),
        h('path', { d: 'm8 10 4 4 4-4' }),
        h('path', { d: 'M5 15v4h14v-4' }),
      ]
    case 'open-new':
      return [
        h('path', { d: 'M14 3h7v7M21 3l-9 9' }),
        h('path', { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }),
      ]
    case 'link':
      return [
        h('path', { d: 'M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1' }),
        h('path', { d: 'M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1' }),
      ]
    case 'copy':
      return [
        h('rect', { x: 9, y: 9, width: 12, height: 12, rx: 2 }),
        h('path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }),
      ]
  }
}

export function renderSessionMenuIcon(name: SessionMenuIconName): VNode {
  return h('svg', {
    class: 'session-menu-icon',
    'data-session-menu-icon': name,
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.7,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  }, iconChildren(name))
}

function actionOption(
  label: string,
  key: string,
  iconName: SessionMenuIconName,
  extra: Partial<DropdownOption> = {},
): DropdownOption {
  return {
    ...extra,
    label,
    key,
    icon: () => renderSessionMenuIcon(iconName),
  } as DropdownOption
}

export function buildActiveSessionMenuOptions(
  labels: ActiveSessionMenuLabels,
  availability: ActiveSessionMenuAvailability = { canRename: true, canOpen: true },
): DropdownOption[] {
  return [
    actionOption(labels.outline, 'outline', 'outline'),
    actionOption(labels.copyId, 'copy-id', 'copy'),
    actionOption(labels.rename, 'rename', 'rename', { disabled: !availability.canRename }),
    actionOption(labels.open, 'open-link', 'open-new', { disabled: !availability.canOpen }),
    ...(labels.cronConsentSetup && availability.canCronConsentSetup
      ? [actionOption(labels.cronConsentSetup, 'cron-consent-setup', 'link')]
      : []),
  ]
}

export function buildSessionContextMenuOptions({
  pinned,
  includeArchive,
  includeModel,
  categoryChildren,
  labels,
}: BuildSessionContextMenuOptions): DropdownOption[] {
  const options: DropdownOption[] = [
    actionOption(pinned ? labels.unpin : labels.pin, 'pin', 'pin'),
    actionOption(labels.rename, 'rename', 'rename'),
  ]

  if (includeArchive) {
    options.push(actionOption(labels.archive, 'archive', 'archive'))
  }

  options.push(actionOption(labels.workspace, 'workspace', 'workspace'))

  if (includeModel) {
    options.push(actionOption(labels.model, 'model', 'model'))
  }

  options.push(actionOption(labels.category, 'category', 'category', {
    children: categoryChildren,
  }))
  options.push(actionOption(labels.export, 'export', 'export', {
    children: [
      {
        label: labels.exportFull,
        key: 'export-full',
        children: [
          { label: 'JSON', key: 'export-full-json' },
          { label: 'TXT', key: 'export-full-txt' },
        ],
      },
      {
        label: labels.exportCompressed,
        key: 'export-compressed',
        children: [
          { label: 'JSON', key: 'export-compressed-json' },
          { label: 'TXT', key: 'export-compressed-txt' },
        ],
      },
    ],
  }))
  options.push(actionOption(labels.open, 'open-link', 'open-new'))
  options.push(actionOption(labels.copyLink, 'copy-link', 'link'))
  options.push(actionOption(labels.copyId, 'copy-id', 'copy'))

  return options
}
