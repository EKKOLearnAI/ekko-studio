import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('screenshotOverlay', {
  submit: (payload: { requestId: string; region: { x: number; y: number; width: number; height: number }; png: Uint8Array }) => ipcRenderer.send('hermes-desktop:screenshot-overlay-submit', payload),
  ready: (requestId: string) => ipcRenderer.send('hermes-desktop:screenshot-overlay-ready', requestId),
  cancel: () => ipcRenderer.send('hermes-desktop:screenshot-overlay-cancel'),
  select: () => ipcRenderer.send('hermes-desktop:screenshot-overlay-select'),
  onInit: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload)
    ipcRenderer.on('hermes-desktop:screenshot-overlay-init', listener)
    return () => ipcRenderer.removeListener('hermes-desktop:screenshot-overlay-init', listener)
  },
  onClear: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('hermes-desktop:screenshot-overlay-clear', listener)
    return () => ipcRenderer.removeListener('hermes-desktop:screenshot-overlay-clear', listener)
  },
  onReset: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('hermes-desktop:screenshot-overlay-reset', listener)
    return () => ipcRenderer.removeListener('hermes-desktop:screenshot-overlay-reset', listener)
  },
})
