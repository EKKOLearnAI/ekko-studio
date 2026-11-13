import { describe, expect, it, vi } from 'vitest'
vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({ getActiveProfileDir: () => '/tmp' }))
vi.mock('../../packages/server/src/modules/studio/services/files/file-provider', () => ({ getTerminalConfig: () => ({ cwd: '/tmp' }) }))
import { runRealtimeCommand } from '../../packages/server/src/modules/studio/services/terminal/realtime-command'
describe('direct command process', () => {
  it('passes metacharacters literally, without shell evaluation', async () => {
    const literal = '$(whoami); echo unsafe | cat'
    const result = await runRealtimeCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', literal])
    expect(result).toMatchObject({ ok: true, stdout: literal, stderr: '' })
  })
  it('reports process failure and bounds returned output', async () => {
    const result = await runRealtimeCommand(process.execPath, ['-e', 'process.stdout.write("a".repeat(5000)); process.exitCode = 3'])
    expect(result.ok).toBe(false)
    expect(String(result.stdout)).toHaveLength(3000)
  })
})
