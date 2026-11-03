import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  assertExternalArtifactPath, taskArtifactsRoot, taskArtifactPath,
  createTaskArtifactDirectory, checkTaskArtifacts,
} from '../../scripts/task-artifacts.mjs'

const temporary: string[] = []
async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), 'studio-artifact-harness-test-'))
  temporary.push(base)
  const root = path.join(base, 'checkout')
  await mkdir(root)
  return { base, root }
}
async function put(root: string, relative: string, content = 'fixture') {
  const file = path.join(root, relative)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content)
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('task artifact paths', () => {
  it('uses a stable external default per checkout and creates isolated marked task directories', async () => {
    const { base, root } = await fixture()
    const other = path.join(base, 'second-checkout')
    await mkdir(other)
    expect(taskArtifactsRoot(root, {})).toBe(taskArtifactsRoot(root, {}))
    expect(taskArtifactsRoot(root, {})).not.toBe(taskArtifactsRoot(other, {}))
    const env = { STUDIO_TASK_ARTIFACTS_DIR: path.join(base, 'outputs') }
    const first = await createTaskArtifactDirectory(root, 'probe', env)
    const second = await createTaskArtifactDirectory(root, 'probe', env)
    expect(first).not.toBe(second)
    expect(first.startsWith(env.STUDIO_TASK_ARTIFACTS_DIR + path.sep)).toBe(true)
    expect(JSON.parse(await readFile(path.join(first, '.studio-task-artifact.json'), 'utf8')).label).toBe('probe')
    expect(await checkTaskArtifacts(root)).toEqual([])
  })

  it('rejects relative paths, checkout paths, category traversal and task traversal', async () => {
    const { root } = await fixture()
    expect(() => taskArtifactsRoot(root, { STUDIO_TASK_ARTIFACTS_DIR: '.tmp' })).toThrow(/absolute/)
    expect(() => taskArtifactsRoot(root, { STUDIO_TASK_ARTIFACTS_DIR: root })).toThrow(/outside/)
    expect(() => taskArtifactsRoot(root, { STUDIO_TASK_ARTIFACTS_DIR: path.join(root, 'new', 'reports') })).toThrow(/outside/)
    expect(() => taskArtifactPath(root, '../escape', {})).toThrow(/category/)
    await expect(createTaskArtifactDirectory(root, '../escape', {})).rejects.toThrow(/label/)
  })

  it('resolves symlink ancestors before accepting an output override', async () => {
    const { base, root } = await fixture()
    await symlink(root, path.join(base, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => assertExternalArtifactPath(root, path.join(base, 'alias', 'not-created', 'output'))).toThrow(/outside/)
  })
})

describe('task artifact guard', () => {
  it('finds ignored, untracked and source-adjacent outputs without relying on Git status', async () => {
    const { root } = await fixture()
    await put(root, '.gitignore', 'coverage\nreports\n')
    await put(root, 'coverage/index.html')
    await put(root, 'reports/feature.md')
    await put(root, 'packages/server/src/.tmp/probe.json')
    await put(root, 'feature-verification.json')
    await put(root, 'debug.log')
    expect((await checkTaskArtifacts(root)).map(message => message.split(':')[0])).toEqual([
      'coverage', 'debug.log', 'feature-verification.json', 'packages/server/src/.tmp', 'reports',
    ])
  })

  it('keeps declared dependencies, build outputs, runtime data and maintained documentation usable', async () => {
    const { root } = await fixture()
    for (const relative of [
      'node_modules/tool/reports/report.json', 'packages/desktop/resources/reports/report.json',
      'packages/server/data/import-report.json', 'hermes_data/reports/report.json',
      'packages/ekko-agent/.ekko/reports/report.json', 'packages/desktop/release/build-report.json',
      'packages/client/dist/report.json', 'packages/mcu/board/.pio/report.json',
      'logs/runtime.log', 'docs/harness/task-artifacts.md', 'tests/server/fixtures/example.ts',
      'docs/screenshots/product.png',
      'docs/chat-chain-changes/2026-09-27-hermes-bridge-compatibility-audit.md',
    ]) await put(root, relative)
    expect(await checkTaskArtifacts(root)).toEqual([])
  })

  it('does not enter nested repositories or follow directory symlinks, and never deletes files', async () => {
    const { base, root } = await fixture()
    await put(root, 'vendor/embedded/.git', 'gitdir: unused')
    await put(root, 'vendor/embedded/reports/keep.json', 'nested-source')
    const outside = path.join(base, 'outside')
    await put(outside, 'reports/keep.json', 'private')
    await symlink(outside, path.join(root, 'linked-runtime'), process.platform === 'win32' ? 'junction' : 'dir')
    await symlink(outside, path.join(root, 'reports'), process.platform === 'win32' ? 'junction' : 'dir')
    expect((await checkTaskArtifacts(root)).map(message => message.split(':')[0])).toEqual(['reports'])
    expect(await readFile(path.join(outside, 'reports/keep.json'), 'utf8')).toBe('private')
    expect(await readFile(path.join(root, 'vendor/embedded/reports/keep.json'), 'utf8')).toBe('nested-source')
  })
})
