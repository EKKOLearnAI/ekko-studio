import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserProfileStore } from '../../packages/desktop/src/main/browser/browser-profile-store'
import type { BrowserProfileCreateInput, DesktopBrowserProfile } from '../../packages/desktop/src/main/browser/browser-types'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function loadCreateProfileHandler(store: BrowserProfileStore) {
  const source = readFileSync('packages/desktop/src/main/index.ts', 'utf8')
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
  const statement = ast.statements.find(statement => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false
    const call = statement.expression
    const channel = call.arguments[0]
    return call.expression.getText(ast) === 'ipcMain.handle'
      && channel && ts.isStringLiteral(channel) && channel.text === 'hermes-desktop:browser-create-profile'
  })
  if (!statement) throw new Error('Browser profile creation IPC handler is missing')
  const compiled = ts.transpileModule(statement.getText(ast), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  let handler: ((event: unknown, input: unknown) => Promise<DesktopBrowserProfile>) | undefined
  runInNewContext(compiled, {
    ipcMain: {
      handle: (_channel: string, callback: typeof handler) => { handler = callback },
    },
    browserForEvent: () => ({ createProfile: (input: BrowserProfileCreateInput) => store.create(input) }),
  })
  if (!handler) throw new Error('Browser profile creation IPC handler was not registered')
  return handler
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ekko-browser-profile-ipc-'))
  roots.push(root)
  const store = new BrowserProfileStore(join(root, 'state'))
  await store.initialize()
  const rootDirectory = join(root, 'work')
  await mkdir(rootDirectory)
  return { createProfile: loadCreateProfileHandler(store), rootDirectory }
}

describe('desktop browser profile creation IPC', () => {
  it.each([undefined, null, '', 'invalid'])('uses the system proxy when the supplied mode is %s', async proxyMode => {
    const { createProfile, rootDirectory } = await setup()
    const profile = await createProfile({}, {
      name: 'Work',
      rootDirectory,
      ...(proxyMode === undefined ? {} : { proxyMode }),
    })
    expect(profile.proxyMode).toBe('system')
    expect(profile.proxyRules).toBe('')
  })

  it.each(['direct', 'system', 'fixed_servers'] as const)('preserves an explicit %s selection', async proxyMode => {
    const { createProfile, rootDirectory } = await setup()
    const proxyRules = proxyMode === 'fixed_servers' ? 'http://127.0.0.1:7890' : ''
    const profile = await createProfile({}, { name: 'Work', rootDirectory, proxyMode, proxyRules })
    expect(profile).toMatchObject({ proxyMode, proxyRules })
  })
})


it('download actions are gated by browserForEvent and accept ids, never renderer file paths', () => {
  const source = readFileSync('packages/desktop/src/main/index.ts', 'utf8')
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
  const statement = ast.statements.find(statement => ts.isExpressionStatement(statement)
    && ts.isCallExpression(statement.expression)
    && statement.expression.arguments[0]?.getText(ast) === "'hermes-desktop:browser-download-action'")
  expect(statement).toBeDefined()
  const compiled = ts.transpileModule(statement!.getText(ast), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  let handler: any
  const calls: unknown[] = []
  runInNewContext(compiled, {
    ipcMain: { handle: (_channel: string, callback: unknown) => { handler = callback } },
    browserForEvent: (event: unknown) => {
      if (event !== 'trusted') throw new Error('untrusted')
      return { downloadAction: (...args: unknown[]) => { calls.push(args) } }
    },
  })
  expect(() => handler('untrusted', 'record', 'open')).toThrow('untrusted')
  expect(() => handler('trusted', { path: '/tmp/file' }, 'open')).toThrow('Invalid')
  expect(() => handler('trusted', 'record', 'execute')).toThrow('Invalid')
  handler('trusted', 'record', 'reveal')
  expect(calls).toEqual([['record', 'reveal']])
  const preload = readFileSync('packages/desktop/src/preload/index.ts', 'utf8')
  expect(preload).toContain("ipcRenderer.invoke('hermes-desktop:browser-download-action', downloadId, action)")
  const broker = readFileSync('packages/desktop/src/main/browser/browser-broker.ts', 'utf8')
  expect(broker).not.toContain("case 'download.action'")
})

it('download availability refresh is restricted to the trusted main window', () => {
  const source = readFileSync('packages/desktop/src/main/index.ts', 'utf8')
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
  const statement = ast.statements.find(statement => ts.isExpressionStatement(statement)
    && ts.isCallExpression(statement.expression)
    && statement.expression.arguments[0]?.getText(ast) === "'hermes-desktop:browser-refresh-downloads'")
  expect(statement).toBeDefined()
  let handler: any
  const refresh = vi.fn()
  runInNewContext(ts.transpileModule(statement!.getText(ast), {}).outputText, {
    ipcMain: { handle: (_: string, callback: unknown) => { handler = callback } },
    browserForEvent: (event: unknown) => {
      if (event !== 'trusted') throw new Error('untrusted')
      return { refreshDownloads: refresh }
    },
  })
  expect(() => handler('untrusted')).toThrow('untrusted')
  handler('trusted')
  expect(refresh).toHaveBeenCalledOnce()
})
