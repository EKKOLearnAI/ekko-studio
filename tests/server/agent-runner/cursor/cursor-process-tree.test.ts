import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import '../../../../packages/server/src/bootstrap/coding-agent-adapters'
import { CodingAgentRunManager } from '../../../../packages/server/src/modules/coding-agents/services/runtime/run-manager'

it.skipIf(process.platform === 'win32').each([false, true])('stopping Cursor also stops its tool process on POSIX (tool ignores SIGINT: %s)', async (toolIgnoresInterrupt) => {
  const root = await mkdtemp(join(tmpdir(), 'cursor-process-tree-'))
  const manager = new CodingAgentRunManager()
  let descendantPid = 0
  let child: any
  try {
    const heartbeat = join(root, 'heartbeat')
    const pidFile = join(root, 'descendant.pid')
    const fixture = join(root, 'cli.cjs')
    const descendant = `const fs = require('node:fs'); ${toolIgnoresInterrupt ? "process.on('SIGINT', () => {});" : ''} setInterval(() => fs.writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now())), 20)`
    await writeFile(fixture, `
      const fs = require('node:fs');
      const { spawn } = require('node:child_process');
      ${toolIgnoresInterrupt ? '' : "process.on('SIGINT', () => {});"}
      const tool = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'inherit' });
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(tool.pid));
      setInterval(() => {}, 1000);
    `)
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
    const command = join(root, 'cursor-fixture')
    await writeFile(command, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o700 })
    // Exercise the actual Cursor spawn and shared stop path, keeping DB/event
    // storage outside this process-ownership regression test.
    const runtime = manager as any
    runtime.touch = () => {}
    runtime.handleClaudePrintResponseEvent = () => {}
    const run = { id: root, launch: { agentId: 'cursor', sessionId: root, command, args: [], workspaceDir: root, mode: 'global', env: {} }, state: { isWorking: true, messages: [], events: [], queue: [] } }
    runtime.startCursorPrintTurn(run, 'run tool')
    child = (run as any).currentChild
    await expect.poll(async () => {
      descendantPid = Number(await readFile(pidFile, 'utf8').catch(() => '0'))
      return readFile(heartbeat, 'utf8').catch(() => '')
    }).not.toBe('')
    const closed = once(child, 'close')
    runtime.cleanupRun(run, { kill: true, reportClosed: false })
    await closed
    const stoppedHeartbeat = await readFile(heartbeat, 'utf8')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(await readFile(heartbeat, 'utf8')).toBe(stoppedHeartbeat)
  } finally {
    if (child?.pid && child.exitCode == null && child.signalCode == null) child.kill('SIGKILL')
    if (descendantPid) { try { process.kill(descendantPid, 'SIGKILL') } catch {} }
    manager.shutdown()
    await rm(root, { recursive: true, force: true })
  }
}, 10_000)
