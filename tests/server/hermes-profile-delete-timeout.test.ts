import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deleteProfile } from '../../packages/server/src/modules/hermes/services/runtime/cli'
import * as hermesProcess from '../../packages/server/src/modules/hermes/services/runtime/process'

const originalBin = process.env.HERMES_BIN
const directories: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  if (originalBin === undefined) delete process.env.HERMES_BIN
  else process.env.HERMES_BIN = originalBin
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

it('allows long profile cleanup and waits for its completion', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  process.env.HERMES_BIN = 'fixture-hermes'
  const exec = vi.spyOn(hermesProcess, 'execHermesWithBin').mockImplementation(() =>
    new Promise(resolve => setTimeout(() => resolve({ stdout: '', stderr: '' }), 11000)),
  )
  let settled = false
  const deleting = deleteProfile('fixture').then(result => { settled = true; return result })
  // Protect the old ten-second cutoff at the process boundary without spending
  // eleven real seconds per run. The subprocess cases below exercise real IO.
  expect(exec).toHaveBeenCalledWith('fixture-hermes', ['profile', 'delete', 'fixture', '--yes'], {
    timeout: 120000, windowsHide: true,
  })
  await vi.advanceTimersByTimeAsync(10999)
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  await expect(deleting).resolves.toBe(true)
})

function fixtureCli(body: string): void {
  const directory = mkdtempSync(join(tmpdir(), 'profile-delete-timeout-'))
  directories.push(directory)
  const bin = join(directory, 'hermes')
  writeFileSync(bin, `#!${process.execPath}\n${body}\n`)
  chmodSync(bin, 0o755)
  process.env.HERMES_BIN = bin
}

describe.skipIf(process.platform === 'win32')('Hermes profile deletion subprocess', () => {
  it('waits for successful cleanup in a real subprocess', async () => {
    fixtureCli(`
      if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['profile', 'delete', 'fixture', '--yes'])) process.exit(2)
      setTimeout(() => process.exit(0), 50)
    `)
    expect(await deleteProfile('fixture')).toBe(true)
  })

  it('still reports failed CLI cleanup as failure', async () => {
    fixtureCli('process.exit(1)')
    expect(await deleteProfile('fixture')).toBe(false)
  })
})
