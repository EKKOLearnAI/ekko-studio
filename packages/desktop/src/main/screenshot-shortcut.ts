import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface ScreenshotShortcutConfig { accelerator: string; hideWindows: boolean }
export interface ScreenshotShortcutState extends ScreenshotShortcutConfig {
  registered: boolean
  error: '' | 'invalid' | 'conflict' | 'saveFailed' | 'hideUnavailable'
}

const modifiers = ['Control', 'Alt', 'Shift', 'Command', 'Super']
const keyPattern = /^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Enter|Escape|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|PrintScreen)$/

export function parseScreenshotShortcut(input: unknown): ScreenshotShortcutConfig {
  if (!input || typeof input !== 'object') throw new Error('Invalid shortcut')
  const { accelerator, hideWindows } = input as ScreenshotShortcutConfig
  if (typeof accelerator !== 'string' || accelerator.length > 100 || typeof hideWindows !== 'boolean') throw new Error('Invalid shortcut')
  if (!accelerator) return { accelerator: '', hideWindows }
  const parts = accelerator.split('+')
  const key = parts.pop()!
  if (!keyPattern.test(key) || !parts.length || new Set(parts).size !== parts.length
    || parts.some(part => !modifiers.includes(part)) || !parts.some(part => part !== 'Shift')) throw new Error('Invalid shortcut')
  return { accelerator: [...modifiers.filter(part => parts.includes(part)), key].join('+'), hideWindows }
}

/** Own just the screenshot binding; an edit lease lets the recorder receive it. */
export class ScreenshotShortcutManager {
  private config: ScreenshotShortcutConfig = { accelerator: '', hideWindows: false }
  private error: ScreenshotShortcutState['error'] = ''
  private registered = ''
  private editors = new Set<string>()
  private disposed = false
  private canHide = false

  constructor(private readonly options: {
    file: string
    shortcuts: { register: (key: string, callback: () => void) => boolean; unregister: (key: string) => void }
    trigger: (hideWindows: boolean) => void
    changed: (state: ScreenshotShortcutState) => void
  }) {}

  getState(): ScreenshotShortcutState {
    return { ...this.config, registered: !!this.registered, error: this.error }
  }

  restore(canHide: boolean): void {
    this.canHide = canHide
    try { this.config = parseScreenshotShortcut(JSON.parse(readFileSync(this.options.file, 'utf8'))) }
    catch { /* Missing or malformed preferences leave the shortcut unset. */ }
    if (this.config.accelerator && this.config.hideWindows && !canHide) this.error = 'hideUnavailable'
    else this.resume()
    this.publish(this.error)
  }

  private register(key: string): boolean {
    try {
      return this.options.shortcuts.register(key, () => {
        if (!this.disposed && !this.editors.size && this.registered === key) this.options.trigger(this.config.hideWindows)
      })
    } catch { return false }
  }

  save(input: unknown, canHide: boolean): ScreenshotShortcutState {
    this.canHide = canHide
    let next: ScreenshotShortcutConfig
    try { next = parseScreenshotShortcut(input) }
    catch { return this.publish('invalid') }
    if (next.accelerator && next.hideWindows && !canHide) return this.publish('hideUnavailable')
    const previous = this.registered
    const needsRegistration = !!next.accelerator && next.accelerator !== previous
    if (needsRegistration && !this.register(next.accelerator)) return this.publish('conflict')
    const temporary = `${this.options.file}.tmp`
    try {
      mkdirSync(dirname(this.options.file), { recursive: true })
      writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 })
      renameSync(temporary, this.options.file)
    } catch {
      try { rmSync(temporary, { force: true }) } catch { /* Preserve the original save error. */ }
      if (needsRegistration) this.options.shortcuts.unregister(next.accelerator)
      return this.publish('saveFailed')
    }
    if (previous && previous !== next.accelerator) this.options.shortcuts.unregister(previous)
    this.config = next
    this.registered = next.accelerator
    if (this.editors.size && this.registered) {
      this.options.shortcuts.unregister(this.registered)
      this.registered = ''
    }
    return this.publish('')
  }

  setEditing(owner: string, editing: boolean): ScreenshotShortcutState {
    if (editing) {
      this.editors.add(owner)
      if (this.registered) this.options.shortcuts.unregister(this.registered)
      this.registered = ''
    } else {
      this.editors.delete(owner)
      this.resume()
    }
    return this.publish(this.error)
  }

  releaseOwner(owner: number): void {
    for (const editor of this.editors) if (editor.startsWith(`${owner}:`)) this.editors.delete(editor)
    this.resume()
    this.publish(this.error)
  }

  private resume(): void {
    if (this.disposed || this.editors.size || this.registered || !this.config.accelerator || (this.config.hideWindows && !this.canHide)) return
    if (this.register(this.config.accelerator)) { this.registered = this.config.accelerator; this.error = '' }
    else this.error = 'conflict'
  }

  private publish(error: ScreenshotShortcutState['error']): ScreenshotShortcutState {
    this.error = error
    const state = this.getState()
    this.options.changed(state)
    return state
  }

  dispose(): void {
    this.disposed = true
    if (this.registered) this.options.shortcuts.unregister(this.registered)
    this.registered = ''
    this.editors.clear()
  }
}

/** Route a global capture to one recently operated composer, never broadcast it. */
export class ScreenshotShortcutTargets {
  private targets = new Map<number, Map<string, number>>()
  private sequence = 0

  claim(owner: number, id: string, activate: boolean): void {
    const targets = this.targets.get(owner) ?? new Map<string, number>()
    if (!targets.has(id) || activate) targets.set(id, ++this.sequence)
    this.targets.set(owner, targets)
  }

  release(owner: number, id?: string): void {
    if (id) this.targets.get(owner)?.delete(id)
    else this.targets.delete(owner)
  }

  pick(eligibleOwners: number[], focusedOwner?: number): { owner: number; targetId: string } | undefined {
    const candidates = eligibleOwners.flatMap(owner => [...(this.targets.get(owner) ?? [])].map(([targetId, sequence]) => ({ owner, targetId, sequence })))
    const focused = candidates.filter(target => target.owner === focusedOwner)
    return (focused.length ? focused : candidates).sort((a, b) => b.sequence - a.sequence)[0]
  }
}
