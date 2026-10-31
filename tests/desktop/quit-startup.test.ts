import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { createDesktopAppLifecycle } from '../../packages/desktop/src/main/app-lifecycle'

function startup(quitExisting: boolean, ownsInstance: boolean) {
  const source = readFileSync('packages/desktop/src/main/index.ts', 'utf8')
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
  const entry = ast.statements.find(statement =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'runDesktopApp')
  if (!entry) throw new Error('Desktop startup function is missing')
  const compiled = ts.transpileModule(entry.getText(ast), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const app = {
    requestSingleInstanceLock: vi.fn(() => ownsInstance),
    getVersion: vi.fn(() => '1.0.0'),
    whenReady: vi.fn(async () => {}),
    quit: vi.fn(),
    relaunch: vi.fn(),
    exit: vi.fn(),
  }
  const coordinator = {
    register: vi.fn(() => { throw new Error('DESKTOP_INSTALLATION_IN_PROGRESS') }),
    recoverInterruptedInstall: vi.fn(),
  }
  const InstallationCoordinator = vi.fn(function () { return coordinator })
  const dialog = { showMessageBox: vi.fn(async () => ({ response: 0 })) }
  const lifecycle = createDesktopAppLifecycle(app)
  const run = runInNewContext(`${compiled}\nrunDesktopApp`, {
    Error, process,
    QUIT_EXISTING: quitExisting,
    app, dialog, InstallationCoordinator,
    installationCoordinator: null,
    quitApp: () => lifecycle.quit(),
    t: (key: string) => key,
  }) as () => Promise<void>
  return { run, app, coordinator, InstallationCoordinator, dialog, lifecycle }
}

describe('installer quit startup', () => {
  it.each([false, true])('delivers quit and exits without touching installation state (owns instance: %s)', async ownsInstance => {
    const h = startup(true, ownsInstance)
    await h.run()
    expect(h.app.requestSingleInstanceLock).toHaveBeenCalledExactlyOnceWith({ quit: true })
    expect(h.app.quit).toHaveBeenCalledOnce()
    expect(h.lifecycle.isQuitting).toBe(true)
    expect(h.InstallationCoordinator).not.toHaveBeenCalled()
    expect(h.coordinator.register).not.toHaveBeenCalled()
    expect(h.coordinator.recoverInterruptedInstall).not.toHaveBeenCalled()
    expect(h.app.whenReady).not.toHaveBeenCalled()
    expect(h.dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('still blocks a normal window while an installation is in progress', async () => {
    const h = startup(false, false)
    await h.run()
    expect(h.coordinator.register).toHaveBeenCalledWith('1.0.0')
    expect(h.dialog.showMessageBox).toHaveBeenCalledOnce()
    expect(h.coordinator.recoverInterruptedInstall).not.toHaveBeenCalled()
    expect(h.app.requestSingleInstanceLock).not.toHaveBeenCalled()
    expect(h.app.quit).toHaveBeenCalledOnce()
  })
})
