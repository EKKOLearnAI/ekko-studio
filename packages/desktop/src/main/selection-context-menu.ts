import { ipcMain, Menu, type BrowserWindow, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron'

export interface MessageSelectionContextMenuRequest {
  label: string
  enabled: boolean
  hasSelection: boolean
}

type MessageMenuAction = 'select-messages' | null
const messageMenus = new WeakMap<BrowserWindow, { menu: Menu; finish: (action: MessageMenuAction) => void }>()

export function closeMessageSelectionContextMenu(targetWindow: BrowserWindow): void {
  const pending = messageMenus.get(targetWindow)
  if (!pending) return
  pending.finish(null)
  if (!targetWindow.isDestroyed()) pending.menu.closePopup(targetWindow)
}

export function showMessageSelectionContextMenu(targetWindow: BrowserWindow, request: unknown): Promise<MessageMenuAction> {
  const input = request as Partial<MessageSelectionContextMenuRequest> | null
  if (!input || typeof input.label !== 'string' || !input.label.trim() || input.label.length > 200
    || typeof input.enabled !== 'boolean' || typeof input.hasSelection !== 'boolean') {
    throw new Error('Invalid message context menu request')
  }
  closeMessageSelectionContextMenu(targetWindow)
  if (targetWindow.isDestroyed()) return Promise.resolve(null)
  const enabled = input.enabled
  return new Promise(resolve => {
    const finish = (action: MessageMenuAction) => {
      if (messageMenus.get(targetWindow)?.finish === finish) messageMenus.delete(targetWindow)
      resolve(action)
    }
    const template: MenuItemConstructorOptions[] = input.hasSelection
      ? [{ role: 'copy' }, { type: 'separator' }]
      : []
    template.push({ label: input.label, enabled, click: () => finish(enabled ? 'select-messages' : null) })
    const menu = Menu.buildFromTemplate(template)
    messageMenus.set(targetWindow, { menu, finish })
    menu.popup({ window: targetWindow, callback: () => finish(null) })
  })
}

export function registerMessageSelectionContextMenuIpc(windowForEvent: (event: IpcMainInvokeEvent) => BrowserWindow): void {
  ipcMain.handle('hermes-desktop:message-context-menu-show', (event, request: unknown) => (
    showMessageSelectionContextMenu(windowForEvent(event), request)
  ))
  ipcMain.handle('hermes-desktop:message-context-menu-close', event => {
    closeMessageSelectionContextMenu(windowForEvent(event))
  })
}

export function installSelectionContextMenu(targetWindow: BrowserWindow): void {
  targetWindow.on('closed', () => closeMessageSelectionContextMenu(targetWindow))
  targetWindow.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) closeMessageSelectionContextMenu(targetWindow)
  })
  targetWindow.webContents.on('render-process-gone', () => closeMessageSelectionContextMenu(targetWindow))
  targetWindow.webContents.on('context-menu', (_event, params) => {
    let template: MenuItemConstructorOptions[]

    if (params.isEditable) {
      template = [
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', enabled: params.editFlags.canSelectAll },
      ]
    } else if (params.selectionText && params.editFlags.canCopy) {
      template = [{ role: 'copy' }]
    } else {
      return
    }

    Menu.buildFromTemplate(template).popup({ window: targetWindow })
  })
}
