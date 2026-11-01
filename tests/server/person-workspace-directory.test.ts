import { afterEach, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { codingAgentWorkingDirectory } from '../../packages/server/src/modules/coding-agents/services/runtime/workspace'
import { requireExistingWorkspaceDirectory } from '../../packages/server/src/modules/studio/services/workspace/directory'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function root() { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'person-directory-'))); roots.push(dir); return dir }

it('canonicalizes a selected directory and rejects missing, empty, relative and file paths without fallback or mkdir', () => {
  const dir = root(), alias = join(dir, 'alias'), selected = join(dir, 'selected'), file = join(dir, 'file')
  mkdirSync(selected); symlinkSync(selected, alias, 'dir'); writeFileSync(file, 'data')
  expect(requireExistingWorkspaceDirectory(alias)).toBe(selected)
  for (const value of ['', 'relative', file, join(dir, 'missing')]) {
    expect(() => requireExistingWorkspaceDirectory(value)).toThrow('Workspace directory is unavailable')
    expect(() => codingAgentWorkingDirectory({ sessionId: 'person-task-one', workspaceDir: value })).toThrow('Workspace directory is unavailable')
  }
  expect(existsSync(join(dir, 'missing'))).toBe(false)
  expect(codingAgentWorkingDirectory({ sessionId: 'ordinary', workspaceDir: join(dir, 'missing') })).toBe(homedir())
})

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('rejects an inaccessible directory', () => {
  const dir = root(), selected = join(dir, 'selected')
  mkdirSync(selected); chmodSync(selected, 0)
  try { expect(() => requireExistingWorkspaceDirectory(selected)).toThrow('Workspace directory is unavailable') }
  finally { chmodSync(selected, 0o700) }
})
