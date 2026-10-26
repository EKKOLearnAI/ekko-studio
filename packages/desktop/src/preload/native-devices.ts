import { contextBridge, ipcRenderer } from 'electron'

// Exposed only in the desktop-owned toolbar and management window.
contextBridge.exposeInMainWorld('studioDevices', {
  state: () => ipcRenderer.invoke('studio-native-devices:state'),
  menu: () => ipcRenderer.invoke('studio-native-devices:menu'),
  dismiss: () => ipcRenderer.invoke('studio-native-devices:dismiss'),
  manage: () => ipcRenderer.invoke('studio-native-devices:manage'),
  add: (input: unknown) => ipcRenderer.invoke('studio-native-devices:add', input),
  remove: (id: unknown) => ipcRenderer.invoke('studio-native-devices:remove', id),
  switchTo: (id: unknown) => ipcRenderer.invoke('studio-native-devices:switch', id),
  confirm: (token: unknown, mode?: 'current' | 'new') => ipcRenderer.invoke('studio-native-devices:confirm', token, mode),
  cancel: (token: unknown) => ipcRenderer.invoke('studio-native-devices:cancel', token),
  onChange: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('studio-native-devices:changed', listener)
    return () => ipcRenderer.removeListener('studio-native-devices:changed', listener)
  },
})
