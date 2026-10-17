import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deleteProfile } from '../../packages/server/src/modules/hermes/services/runtime/cli'

const originalBin = process.env.HERMES_BIN
const directories: string[] = []

afterEach(() => {
  if (originalBin === undefined) delete process.env.HERMES_BIN
  else process.env.HERMES_BIN = originalBin
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
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
  it('waits for successful cleanup lasting longer than ten seconds', async () => {
    fixtureCli(`
      if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['profile', 'delete', 'fixture', '--yes'])) process.exit(2)
      setTimeout(() => process.exit(0), 11000)
    `)
    expect(await deleteProfile('fixture')).toBe(true)
  }, 20000)

  it('still reports failed CLI cleanup as failure', async () => {
    fixtureCli('process.exit(1)')
    expect(await deleteProfile('fixture')).toBe(false)
  })
})
