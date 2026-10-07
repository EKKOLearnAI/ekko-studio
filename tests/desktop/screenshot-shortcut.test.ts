import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseScreenshotShortcut, ScreenshotShortcutManager, ScreenshotShortcutTargets } from '../../packages/desktop/src/main/screenshot-shortcut'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'studio-shortcut-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

function setup(file = join(directory, 'shortcut.json'), canHide = true) {
  const bindings = new Map<string, () => void>()
  const shortcuts = {
    register: vi.fn((key: string, callback: () => void) => {
      if (bindings.has(key)) return false
      bindings.set(key, callback)
      return true
    }),
    unregister: vi.fn((key: string) => { bindings.delete(key) }),
  }
  const trigger = vi.fn()
  const manager = new ScreenshotShortcutManager({ file, shortcuts, trigger, changed: vi.fn() })
  manager.restore(canHide)
  return { manager, shortcuts, bindings, trigger, file }
}

describe('global screenshot shortcut', () => {
  it('persists, restores, changes capture mode and clears the owned binding', () => {
    const state = setup()
    expect(state.manager.save({ accelerator: 'Shift+Command+S', hideWindows: true }, true)).toMatchObject({ accelerator: 'Shift+Command+S', registered: true, error: '' })
    state.bindings.get('Shift+Command+S')!()
    expect(state.trigger).toHaveBeenLastCalledWith(true)
    state.manager.save({ accelerator: 'Command+Shift+S', hideWindows: false }, true)
    expect(state.shortcuts.register).toHaveBeenCalledOnce()
    state.bindings.get('Shift+Command+S')!()
    expect(state.trigger).toHaveBeenLastCalledWith(false)
    state.manager.dispose()
    const restored = setup(state.file)
    expect(restored.manager.getState()).toMatchObject({ accelerator: 'Shift+Command+S', hideWindows: false, registered: true })
    restored.bindings.set('Control+Z', vi.fn())
    restored.manager.save({ accelerator: '', hideWindows: false }, true)
    expect(restored.bindings.has('Shift+Command+S')).toBe(false)
    expect(restored.bindings.has('Control+Z')).toBe(true)
    expect(JSON.parse(readFileSync(state.file, 'utf8')).accelerator).toBe('')
  })

  it('keeps the previous shortcut and preferences when another app owns the new combination', () => {
    const state = setup()
    state.manager.save({ accelerator: 'Control+S', hideWindows: false }, true)
    state.bindings.set('Control+A', vi.fn())
    expect(state.manager.save({ accelerator: 'Control+A', hideWindows: true }, true)).toMatchObject({ accelerator: 'Control+S', registered: true, error: 'conflict' })
    state.bindings.get('Control+S')!()
    expect(state.trigger).toHaveBeenCalledWith(false)
    expect(JSON.parse(readFileSync(state.file, 'utf8')).accelerator).toBe('Control+S')
  })

  it('rolls back a successfully reserved binding if writing preferences fails', () => {
    const state = setup()
    state.manager.save({ accelerator: 'Control+S', hideWindows: false }, true)
    rmSync(directory, { recursive: true })
    writeFileSync(directory, 'block writes')
    expect(state.manager.save({ accelerator: 'Control+A', hideWindows: true }, true)).toMatchObject({ accelerator: 'Control+S', error: 'saveFailed', registered: true })
    expect(state.bindings.has('Control+A')).toBe(false)
    state.bindings.get('Control+S')!()
    expect(state.trigger).toHaveBeenCalledWith(false)
  })

  it('pauses only its own binding until all recording windows close, including a crashed renderer', () => {
    const state = setup()
    state.manager.save({ accelerator: 'Control+S', hideWindows: false }, true)
    const staleCallback = state.bindings.get('Control+S')!
    state.bindings.set('Control+A', vi.fn())
    state.manager.setEditing('1:first', true)
    state.manager.setEditing('2:second', true)
    expect(state.bindings.has('Control+S')).toBe(false)
    expect(state.bindings.has('Control+A')).toBe(true)
    staleCallback()
    expect(state.trigger).not.toHaveBeenCalled()
    state.manager.save({ accelerator: 'Control+Shift+S', hideWindows: true }, true)
    state.manager.setEditing('1:first', false)
    expect(state.bindings.has('Control+Shift+S')).toBe(false)
    state.manager.releaseOwner(2)
    state.bindings.get('Control+Shift+S')!()
    expect(state.trigger).toHaveBeenCalledWith(true)
    state.manager.dispose()
    state.manager.setEditing('2:second', false)
    expect(state.bindings.has('Control+Shift+S')).toBe(false)
  })

  it('reports a conflict if another application claims the shortcut during recording', () => {
    const state = setup()
    state.manager.save({ accelerator: 'Control+S', hideWindows: false }, true)
    state.manager.setEditing('1:recording', true)
    state.bindings.set('Control+S', vi.fn())
    expect(state.manager.setEditing('1:recording', false)).toMatchObject({ registered: false, error: 'conflict', accelerator: 'Control+S' })
  })

  it('rejects unsupported hiding without replacing the ordinary shortcut', () => {
    const state = setup()
    state.manager.save({ accelerator: 'Control+S', hideWindows: false }, false)
    state.manager.setEditing('1:recording', true)
    expect(state.manager.save({ accelerator: 'Control+A', hideWindows: true }, false).error).toBe('hideUnavailable')
    expect(state.manager.setEditing('1:recording', false)).toMatchObject({ accelerator: 'Control+S', registered: true, error: '' })
    state.manager.dispose()
    writeFileSync(state.file, JSON.stringify({ accelerator: 'Control+S', hideWindows: true }))
    expect(setup(state.file, false).manager.getState()).toMatchObject({ registered: false, error: 'hideUnavailable' })
  })

  it('ignores corrupt preferences and validates combinations from the renderer', () => {
    const file = join(directory, 'shortcut.json')
    writeFileSync(file, '{invalid')
    const { manager } = setup(file)
    expect(manager.getState()).toMatchObject({ accelerator: '', registered: false })
    for (const accelerator of ['S', 'Shift+S', 'Control+Control+S', 'Control+;', 'Control+F25', 'Control+S+A']) {
      expect(manager.save({ accelerator, hideWindows: false }, true).error).toBe('invalid')
    }
    expect(() => parseScreenshotShortcut({ accelerator: 'Alt+S', hideWindows: 'yes' })).toThrow()
    expect(parseScreenshotShortcut({ accelerator: 'Super+Alt+Shift+F12', hideWindows: false }).accelerator).toBe('Alt+Shift+Super+F12')
  })
})

describe('screenshot shortcut composer routing', () => {
  it('chooses one recently operated composer, prefers a focused chat window and ignores closed windows', () => {
    const targets = new ScreenshotShortcutTargets()
    targets.claim(1, 'main', false)
    targets.claim(1, 'sidebar', false)
    targets.claim(2, 'detached-chat', false)
    targets.claim(1, 'main', true)
    expect(targets.pick([1, 2])).toMatchObject({ owner: 1, targetId: 'main' })
    expect(targets.pick([1, 2], 2)).toMatchObject({ owner: 2, targetId: 'detached-chat' })
    targets.release(1, 'sidebar')
    expect(targets.pick([1, 2])!.targetId).toBe('main')
    targets.release(1)
    expect(targets.pick([1, 2])).toMatchObject({ owner: 2, targetId: 'detached-chat' })
    expect(targets.pick([3])).toBeUndefined()
  })
})
