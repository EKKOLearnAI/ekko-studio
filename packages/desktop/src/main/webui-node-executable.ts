import { accessSync, constants } from 'node:fs'
import { basename, dirname, join } from 'node:path'

interface WebUiNodeExecutableOptions {
  platform?: NodeJS.Platform
  executable?: string
  electron?: boolean
}

export function resolveWebUiNodeExecutable(options: WebUiNodeExecutableOptions = {}): string {
  const platform = options.platform ?? process.platform
  const executable = options.executable ?? process.execPath
  const electron = options.electron ?? Boolean(process.versions.electron)
  if (platform !== 'darwin' || !electron) return executable

  // Native libraries such as Cua can register a Node-mode process with AppKit.
  // The generic Electron Helper has LSUIElement=true, so that registration
  // cannot create a second, indefinitely bouncing Dock icon for the backend.
  const contents = dirname(dirname(executable))
  const name = basename(executable)
  const alreadyHelper = name.endsWith(' Helper') && basename(dirname(dirname(contents))) === 'Frameworks'
  const helper = alreadyHelper ? executable : join(
    contents, 'Frameworks', `${name} Helper.app`, 'Contents', 'MacOS', `${name} Helper`,
  )
  try {
    accessSync(helper, constants.X_OK)
  } catch (cause) {
    // Falling back to the GUI executable would silently reintroduce the bug.
    throw new Error(`macOS Web UI Helper is missing or not executable: ${helper}`, { cause })
  }
  return helper
}
