import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const mocks = vi.hoisted(() => ({ exec: vi.fn((_command: string, _args: string[], _options: object, callback: (error: Error) => void) => callback(new Error('no network in test'))) }))
vi.mock('node:child_process', () => ({ execFile: mocks.exec }))
import { installPackage } from '../../packages/server/src/modules/studio/services/plugins/installer'
const directories: string[] = []
afterEach(async () => { vi.clearAllMocks(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

it.each(['gitlab.com/team/subgroup/notes', 'gitee.com/example/notes'])('uses an immutable public source for %s without enabling install scripts', async repository => {
  const directory = await mkdtemp(join(tmpdir(), 'plugin-release-source-')); directories.push(directory)
  const source = `git+https://${repository}.git#${'a'.repeat(40)}`
  await expect(installPackage(directory, source)).rejects.toThrow('Package installation failed')
  expect(mocks.exec).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['--ignore-scripts', '--', source]), expect.objectContaining({ timeout: 120_000 }), expect.any(Function))
})
it.each(['git+https://gitlab.com/team/notes.git#main', 'git+https://evil.test/team/notes.git#' + 'a'.repeat(40), 'git+https://user:pass@gitee.com/team/notes.git#' + 'a'.repeat(40)])('rejects mutable or unsupported release source %s', async source => {
  const directory = await mkdtemp(join(tmpdir(), 'plugin-release-source-')); directories.push(directory)
  await expect(installPackage(directory, source)).rejects.toThrow('supported repository pinned to a full commit')
  expect(mocks.exec).not.toHaveBeenCalled()
})
