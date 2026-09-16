import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { expect, it } from 'vitest'
import { pty } from '../../packages/server/src/modules/hermes/services/terminal/runtime'
import { MobileTerminalSessions } from '../../packages/server/src/modules/hermes/services/terminal/mobile-sessions'

it.skipIf(!pty)('runs a real PTY in its workspace and keeps output across writer detach', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mobile-terminal-pty-'))
  const sessions = new MobileTerminalSessions((cwd, shell, cols, rows) => pty.spawn(shell, [], { cwd, cols, rows, name: 'xterm-256color' }))
  const scope = { owner: 'smoke', userId: 1, profile: 'default', source: 'single', sourceId: 'smoke' }
  try {
    const terminal = sessions.create(scope, 'real-pty-smoke', cwd, process.platform === 'win32' ? 'powershell.exe' : '/bin/sh', 80, 24)
    const first = sessions.attach(scope, terminal.id, 'first')
    const command = process.platform === 'win32' ? 'Write-Output MOBILE_TERMINAL_OK; Get-Location; exit\r' : "printf 'MOBILE_TERMINAL_OK\\n'; pwd; exit\r"
    sessions.input(scope, terminal.id, 'first', first.lease, 1, command)
    sessions.detachWriter('first')
    const second = sessions.attach(scope, terminal.id, 'second')
    let output = ''; let cursor = 0; let exitCode: number | null = null
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const batch = sessions.read(scope, terminal.id, 'second', second.lease, cursor)
      output += batch.chunks.map(c => c.data).join(''); cursor = batch.cursor; exitCode = batch.exitCode
      if (exitCode !== null && cursor === batch.latest) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(exitCode).toBe(0)
    expect(output).toContain('MOBILE_TERMINAL_OK')
    // macOS may resolve /var to /private/var in pwd.
    expect(output).toContain(cwd)
  } finally { sessions.shutdown(); rmSync(cwd, { recursive: true, force: true }) }
}, 10_000)
