import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AntigravityApprovalGate } from '../../packages/server/src/modules/coding-agents/services/antigravity/approvals'
const dirs: string[] = [], gates: AntigravityApprovalGate[] = []
afterEach(async () => { for (const gate of gates.splice(0)) gate.close(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
const operation = { toolCall: { name: 'run_command', args: { CommandLine: 'printf APPROVAL_TEST' } } }
async function setup(timeout = 300000) {
 const dir = await mkdtemp('/tmp/agy-gate-test-'); dirs.push(dir)
 const events: any[] = []; const path = join(dir, 'grants.json')
 const gate = new AntigravityApprovalGate(join(dir, 'gate.sock'), path, (event, payload) => events.push({ event, ...payload }), timeout); gates.push(gate)
 await new Promise<void>(resolve => gate.server.once('listening', resolve))
 return { gate, events, path, dir }
}
async function requested(events: any[]) { for (let i = 0; i < 100 && !events.some(event => event.event === 'approval.requested'); i++) await new Promise(resolve => setTimeout(resolve, 2)); return events.find(event => event.event === 'approval.requested').approval_id }
describe('Antigravity unified approval scope', () => {
 it('supports once/session/always/deny without a broad grant', async () => {
  const { gate, events, path } = await setup()
  const once = gate.request(operation); gate.respond(await requested(events), 'once'); expect(await once).toBe('once')
  events.length = 0
  const session = gate.request(operation); gate.respond(await requested(events), 'session'); expect(await session).toBe('session')
  events.length = 0; expect(await gate.request(operation)).toBe('session'); expect(events).toHaveLength(0)
  const changed = { toolCall: { name: 'run_command', args: { CommandLine: 'printf ANOTHER' } } }
  const always = gate.request(changed); gate.respond(await requested(events), 'always'); expect(await always).toBe('always')
  const stored = JSON.parse(await readFile(path, 'utf8')); expect(stored.allow).toHaveLength(1); expect(stored.allow[0]).toMatch(/^[a-f0-9]{64}$/)
  const second = new AntigravityApprovalGate(join(dirname(path), 'second.sock'), path, () => { throw new Error('should not prompt') }); gates.push(second)
  expect(await second.request(changed)).toBe('always'); expect(await second.request(operation)).toBe('deny')
 })
 it('denies on timeout and stop and rejects unknown choice', async () => {
  const { gate, events } = await setup(15)
  const request = gate.request(operation); const id = await requested(events)
  expect(gate.respond(id, 'invalid')).toEqual({ handled: true, resolved: false })
  await new Promise(resolve => setTimeout(resolve, 25)); expect(await request).toBe('deny')
  events.length = 0; const pending = gate.request(operation); await requested(events); gate.close(); expect(await pending).toBe('deny')
  expect(await gate.request(operation)).toBe('deny')
 })
 it('does not accept corrupt persistent policy or malformed operations', async () => {
  const { gate, path } = await setup(); await writeFile(path, '[]')
  expect(await gate.request(operation)).toBe('deny'); expect(await gate.request({})).toBe('deny')
 })
})
import { dirname } from 'node:path'
