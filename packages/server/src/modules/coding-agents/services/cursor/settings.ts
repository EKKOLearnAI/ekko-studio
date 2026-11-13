import { join, resolve } from 'node:path'

export function cursorSettingsPath(home: string): string {
  const override = process.env.CURSOR_CONFIG_DIR
  const xdg = process.env.XDG_CONFIG_HOME
  const directory = override?.trim() ? override : xdg?.trim() ? join(xdg, 'cursor') : join(home, '.cursor')
  return resolve(directory, 'cli-config.json')
}

export const CURSOR_DEFAULT_SETTINGS = `${JSON.stringify({
  version: 1,
  editor: { vimMode: false },
  permissions: { allow: [], deny: [] },
}, null, 2)}\n`

export function validateCursorSettings(content: string): void {
  try {
    const value = JSON.parse(content)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object')
  } catch {
    throw Object.assign(new Error('Cursor CLI settings must be a valid JSON object'), { status: 400 })
  }
}
