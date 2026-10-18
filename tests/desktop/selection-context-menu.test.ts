import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  buildFromTemplate: vi.fn(),
  popup: vi.fn(),
  closePopup: vi.fn(),
  handle: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: { handle: electronMocks.handle },
  Menu: {
    buildFromTemplate: electronMocks.buildFromTemplate,
  },
}))

import { closeMessageSelectionContextMenu, installSelectionContextMenu, registerMessageSelectionContextMenuIpc, showMessageSelectionContextMenu } from '../../packages/desktop/src/main/selection-context-menu'

type ContextMenuHandler = (
  event: unknown,
  params: {
    selectionText: string
    isEditable: boolean
    editFlags: {
      canCut: boolean
      canCopy: boolean
      canPaste: boolean
      canSelectAll: boolean
    }
  },
) => void

function contextMenuParams({
  selectionText = '',
  isEditable = false,
  canCut = false,
  canCopy = false,
  canPaste = false,
  canSelectAll = false,
} = {}) {
  return {
    selectionText,
    isEditable,
    editFlags: { canCut, canCopy, canPaste, canSelectAll },
  }
}

function setupContextMenu() {
  let handler: ContextMenuHandler | undefined
  const webContents = {
    on: vi.fn((event: string, listener: ContextMenuHandler) => {
      if (event === 'context-menu') handler = listener
    }),
  }
  const targetWindow = { webContents, on: vi.fn(), isDestroyed: vi.fn(() => false) }

  installSelectionContextMenu(targetWindow as never)

  return {
    handler: () => {
      expect(handler).toBeTypeOf('function')
      return handler!
    },
    targetWindow,
    webContents,
  }
}

describe('desktop selection context menu', () => {
  beforeEach(() => {
    electronMocks.buildFromTemplate.mockReset()
    electronMocks.popup.mockReset()
    electronMocks.closePopup.mockReset()
    electronMocks.handle.mockReset()
    electronMocks.buildFromTemplate.mockImplementation(() => ({ popup: electronMocks.popup, closePopup: electronMocks.closePopup }))
  })

  it('registers the selection menu on the main desktop window', () => {
    const source = readFileSync(resolve('packages/desktop/src/main/index.ts'), 'utf8')

    expect(source).toContain("import { installSelectionContextMenu, registerMessageSelectionContextMenuIpc } from './selection-context-menu'")
    expect(source).toContain('installSelectionContextMenu(mainWindow)')
    expect(source).toContain('installSelectionContextMenu(chatWindow)')
    expect(source).toContain('registerMessageSelectionContextMenuIpc(studioChatWindow)')
  })

  it('shows the native copy action for a copyable text selection', () => {
    const { handler, targetWindow, webContents } = setupContextMenu()

    expect(webContents.on).toHaveBeenCalledWith('context-menu', expect.any(Function))
    handler()({}, contextMenuParams({ selectionText: 'selected reply text', canCopy: true }))

    expect(electronMocks.buildFromTemplate).toHaveBeenCalledWith([{ role: 'copy' }])
    expect(electronMocks.popup).toHaveBeenCalledWith({ window: targetWindow })
  })

  it('shows standard editing actions, including paste, in editable fields', () => {
    const { handler, targetWindow } = setupContextMenu()

    handler()({}, contextMenuParams({
      selectionText: 'draft text',
      isEditable: true,
      canCut: true,
      canCopy: true,
      canPaste: true,
      canSelectAll: true,
    }))

    expect(electronMocks.buildFromTemplate).toHaveBeenCalledWith([
      { role: 'cut', enabled: true },
      { role: 'copy', enabled: true },
      { role: 'paste', enabled: true },
      { type: 'separator' },
      { role: 'selectAll', enabled: true },
    ])
    expect(electronMocks.popup).toHaveBeenCalledWith({ window: targetWindow })
  })

  it('does not replace existing context menus when there is no copyable selection', () => {
    const { handler } = setupContextMenu()

    handler()({}, contextMenuParams({ canCopy: true }))
    handler()({}, contextMenuParams({ selectionText: 'selected reply text' }))

    expect(electronMocks.buildFromTemplate).not.toHaveBeenCalled()
  })

  it('combines native Copy with localized message selection and returns the chosen action', async () => {
    const { targetWindow } = setupContextMenu()
    const result = showMessageSelectionContextMenu(targetWindow as never, { label: '多选消息', enabled: true, hasSelection: true })
    const items = electronMocks.buildFromTemplate.mock.calls[0][0]
    expect(items).toEqual([{ role: 'copy' }, { type: 'separator' }, { label: '多选消息', enabled: true, click: expect.any(Function) }])
    items[2].click()
    electronMocks.popup.mock.calls[0][0].callback()
    expect(await result).toBe('select-messages')
  })

  it('shows only message selection without text and resolves dismissal without an action', async () => {
    const { targetWindow } = setupContextMenu()
    const result = showMessageSelectionContextMenu(targetWindow as never, { label: 'Select messages', enabled: true, hasSelection: false })
    expect(electronMocks.buildFromTemplate.mock.calls[0][0]).toEqual([{ label: 'Select messages', enabled: true, click: expect.any(Function) }])
    electronMocks.popup.mock.calls[0][0].callback()
    expect(await result).toBeNull()
  })

  it('keeps Copy available while message selection is disabled', async () => {
    const { targetWindow } = setupContextMenu()
    const result = showMessageSelectionContextMenu(targetWindow as never, { label: 'Select messages', enabled: false, hasSelection: true })
    const items = electronMocks.buildFromTemplate.mock.calls[0][0]
    expect(items[0]).toEqual({ role: 'copy' })
    expect(items[2].enabled).toBe(false)
    items[2].click()
    expect(await result).toBeNull()
  })

  it('closes stale menus, ignores their later callbacks and isolates windows', async () => {
    const first = setupContextMenu().targetWindow
    const second = setupContextMenu().targetWindow
    const request = { label: 'Select messages', enabled: true, hasSelection: false }
    const old = showMessageSelectionContextMenu(first as never, request)
    const oldClick = electronMocks.buildFromTemplate.mock.calls[0][0][0].click
    const current = showMessageSelectionContextMenu(first as never, request)
    expect(await old).toBeNull()
    const other = showMessageSelectionContextMenu(second as never, request)
    oldClick()
    closeMessageSelectionContextMenu(first as never)
    expect(await current).toBeNull()
    expect(electronMocks.closePopup).toHaveBeenCalledTimes(2)
    electronMocks.buildFromTemplate.mock.calls[2][0][0].click()
    expect(await other).toBe('select-messages')
  })

  it.each(['closed', 'did-start-navigation', 'render-process-gone'])('cancels the pending menu on %s', async event => {
    const { targetWindow, webContents } = setupContextMenu()
    const result = showMessageSelectionContextMenu(targetWindow as never, { label: 'Select messages', enabled: true, hasSelection: false })
    if (event === 'closed') {
      targetWindow.isDestroyed.mockReturnValue(true)
      targetWindow.on.mock.calls.find(call => call[0] === event)![1]()
    } else {
      const listener = webContents.on.mock.calls.find(call => call[0] === event)![1] as Function
      listener({}, '', false, true)
    }
    expect(await result).toBeNull()
  })

  it.each([null, {}, { label: '', enabled: true, hasSelection: false }, { label: 'Select messages', enabled: 'yes', hasSelection: false }])('rejects malformed menu requests', request => {
    const { targetWindow } = setupContextMenu()
    expect(() => showMessageSelectionContextMenu(targetWindow as never, request)).toThrow('Invalid message context menu request')
    expect(electronMocks.buildFromTemplate).not.toHaveBeenCalled()
  })

  it('authorizes both IPC operations and opens the menu only in the sender window', async () => {
    const { targetWindow } = setupContextMenu()
    const authorize = vi.fn(() => targetWindow as never)
    registerMessageSelectionContextMenuIpc(authorize)
    const show = electronMocks.handle.mock.calls.find(call => call[0].endsWith('-show'))![1]
    const close = electronMocks.handle.mock.calls.find(call => call[0].endsWith('-close'))![1]
    const event = { sender: targetWindow.webContents }
    const result = show(event, { label: 'Select messages', enabled: true, hasSelection: false })
    expect(electronMocks.popup).toHaveBeenCalledWith({ window: targetWindow, callback: expect.any(Function) })
    close(event)
    expect(await result).toBeNull()
    expect(authorize.mock.calls).toEqual([[event], [event]])
    authorize.mockImplementation(() => { throw new Error('Untrusted window') })
    expect(() => show({}, {})).toThrow('Untrusted window')
    expect(() => close({})).toThrow('Untrusted window')
  })
})
