import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'

const state = vi.hoisted(() => ({
  execFail: vi.fn(),
  merge: vi.fn(),
  read: vi.fn(() => ({ const: async () => null })),
}))

// Load the action with an SDK adapter so the main test suite does not require
// installing the independent package's SDK or running a StartOS host.
const sdk = {
  Action: {
    withoutInput: (id: string, metadata: unknown, run: unknown) => ({ id, metadata, run }),
  },
  Mounts: { of: () => ({ mountVolume: () => ({}) }) },
  SubContainer: {
    withTemp: async (_effects: unknown, _image: unknown, _mounts: unknown, _name: string, fn: any) =>
      fn({ execFail: state.execFail }),
  },
}
const dependencies: Record<string, unknown> = {
  '../sdk': { sdk },
  './sdk': { sdk },
  '../i18n': { i18n: (value: string) => value },
  '../fileModels/store.json': { storeJson: { merge: state.merge, read: state.read } },
  '@start9labs/start-sdk': { utils: { getDefaultString: () => 'A'.repeat(32) } },
}
function loadPackageModule(path: string) {
  const exports: Record<string, any> = {}
  const code = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  runInNewContext(code, {
    exports,
    require: (name: string) => {
      if (!(name in dependencies)) throw new Error(`Unexpected package import: ${name}`)
      return dependencies[name]
    },
  })
  return exports
}
dependencies['../utils'] = loadPackageModule('packages/startos/startos/utils.ts')
const action = loadPackageModule('packages/startos/startos/actions/setAdminPassword.ts').setAdminPassword

beforeEach(() => {
  state.execFail.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
  state.merge.mockReset().mockResolvedValue(undefined)
})

describe('StartOS administrator setup', () => {
  it('only offers the database-changing operation while stopped', async () => {
    expect((await action.metadata({ effects: {} })).allowedStatuses).toBe('only-stopped')
  })

  it('leaves startup blocked when upstream credential application fails', async () => {
    state.execFail.mockRejectedValueOnce(new Error('Upstream password change failed'))
    await expect(action.run({ effects: {} })).rejects.toThrow('Upstream password change failed')
    expect(state.merge.mock.calls.map(call => call[1])).toEqual([{ adminPassword: null }])
  })

  it('applies the generated password before clearing the setup gate and returning it masked', async () => {
    const order: string[] = []
    state.merge.mockImplementation(async (_effects, patch) => {
      order.push(patch.adminPassword === null ? 'block' : 'store')
    })
    state.execFail.mockImplementation(async () => { order.push('apply'); return {} })
    const result = await action.run({ effects: {} })
    expect(order).toEqual(['block', 'apply', 'store'])
    const password = state.merge.mock.calls[1][1].adminPassword
    expect(password).toMatch(/^[a-zA-Z0-9]{32}$/)
    expect(state.execFail.mock.calls[0][1].env.STARTOS_ADMIN_PASSWORD).toBe(password)
    expect(result.result.value.find((value: any) => value.masked)).toMatchObject({
      value: password, masked: true, copyable: true,
    })
  })
})

describe('independent main-repository StartOS build', () => {
  const workflow = parse(readFileSync('.github/workflows/startos-package.yml', 'utf8'))
  it('runs only on demand or relevant PRs and does not grant publish permissions', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch', 'pull_request'])
    expect(workflow.on.pull_request.paths).toContain('packages/startos/**')
    expect(workflow.permissions).toEqual({ contents: 'read' })
  })
  it('builds both native architectures from the package subdirectory', () => {
    const job = workflow.jobs.package
    expect(job.strategy.matrix.include).toEqual([
      { target: 'x86', arch: 'x86_64', runner: 'ubuntu-24.04' },
      { target: 'arm', arch: 'aarch64', runner: 'ubuntu-24.04-arm' },
    ])
    expect(job.defaults.run['working-directory']).toBe('packages/startos')
    const upload = job.steps.find((step: any) => step.uses === 'actions/upload-artifact@v4')
    expect(upload.with['if-no-files-found']).toBe('error')
    expect(upload.with.path).toContain('packages/startos/*.s9pk')
  })
})
