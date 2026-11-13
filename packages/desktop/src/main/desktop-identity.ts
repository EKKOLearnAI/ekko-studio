import type { App } from 'electron'

export function configureDesktopIdentity(app: Pick<App, 'getPath' | 'setPath' | 'setName'>) {
  // Electron derives this path from package.json's name, not the installer display
  // name. Pin the existing profile before changing the name used by the UI.
  const existingUserData = app.getPath('userData')
  app.setPath('userData', existingUserData)
  app.setName('Ekko Studio')
}
