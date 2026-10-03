import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CodingAgentRunManager } from '../../packages/server/src/modules/coding-agents/services/runtime/run-manager'
import { configureRunState } from '../../packages/server/src/modules/studio/public/run-state'
import { applyResponseStreamEvent } from '../../packages/server/src/modules/studio/services/chat-run/response-stream'

const roots: string[] = []
const acpAgents = ['qwen', 'kimi', 'codebuddy', 'qoder', 'copilot'] as const
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

const fixtureSource = String.raw`
const { createHash } = require('node:crypto')
const check = text => {
  const hash = createHash('sha256').update(text).digest('hex')
  if (hash !== process.env.EXPECTED_PROMPT_HASH) throw new Error('Prompt corrupted in transport')
  return 'fixture:' + hash
}
const args = process.argv.slice(2)
if (args.includes('-p')) {
  if (require.main !== module) throw new Error('CLI must run as main module')
  const response = check(args[args.indexOf('-p') + 1])
  process.stdout.write(JSON.stringify({ type: 'result', sessionId: 'fixture-native', response, projection: { status: 'completed' } }) + '\n')
} else {
  if (!args.includes('--acp') && !args.includes('acp')) throw new Error('Missing ACP flag')
  const lines = require('node:readline').createInterface({ input: process.stdin, crlfDelay: Infinity })
  lines.on('line', line => {
    const request = JSON.parse(line)
    let result = {}
    if (request.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: true } }
    if (request.method === 'session/new' || request.method === 'session/load') result = { sessionId: 'fixture-native' }
    if (request.method === 'session/prompt') {
      const text = check(request.params.prompt[0].text)
      process.stdout.write(JSON.stringify({ method: 'session/update', params: { sessionId: 'fixture-native',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } }) + '\n')
      if (process.env.WAIT_FOR_CANCEL) return
      result = { stopReason: 'end_turn' }
    }
    if (request.id !== undefined) process.stdout.write(JSON.stringify({ id: request.id, result }) + '\n')
  })
}
`

beforeAll(() => {
  configureRunState({ applyResponseStreamEvent, calcAndUpdateUsage: async () => ({}),
    completeWorkspaceRunCheckpoint: () => undefined, extractResponseText: () => '',
    flushResponseRunToDb: () => undefined, getChatRunServer: () => null,
    getOrCreateSession: () => ({ messages: [], isWorking: false, events: [], queue: [] }) as any,
    startWorkspaceRunCheckpoint: () => undefined, updateContextTokenUsage: () => undefined })
})

afterAll(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })))
})

async function setup(agent: string, mode: 'scoped' | 'global', prompt: string, bundled = false, waitForCancel = false) {
  const root = await mkdtemp(join(tmpdir(), 'Ekko coding 中文 '))
  roots.push(root)
  const bin = join(root, '工具 目录')
  const workspaceDir = join(root, '工作区 目录')
  await mkdir(bin)
  await mkdir(workspaceDir)
  const entry = join(bin, 'cli-fixture.cjs')
  await writeFile(entry, fixtureSource, 'utf8')
  const command = bundled ? process.execPath : join(bin, process.platform === 'win32' ? `${agent}.cmd` : agent)
  if (!bundled) {
    const script = process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "%~dp0cli-fixture.cjs" %*\r\n`
      : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${entry.replaceAll("'", "'\\''")}' "$@"\n`
    await writeFile(command, script, 'utf8')
    await chmod(command, 0o700)
  }
  const manager = new CodingAgentRunManager(60_000)
  const events: Array<{ event: string; payload: any }> = []
  const host = manager as any
  host.ensureDbSession = () => {}
  host.addUserMessage = () => 1
  host.emitToChat = (_id: string, event: string, payload: any) => events.push({ event, payload })
  host.persistTerminalResponse = (run: any) => { run.state.responseRun = undefined }
  host.markChatRunCompleted = () => {}
  host.startWorkspaceRunDiff = () => {}
  host.completeWorkspaceRunDiff = () => undefined
  host.startCodingAgentMemoryExport = () => {}
  manager.start({ agentSessionId: `platform-${agent}`, agentId: agent as any, mode, profile: '默认',
    provider: 'fixture', model: 'fixture', sessionId: 'platform-session', command, args: bundled ? [entry] : [],
    env: { EXPECTED_PROMPT_HASH: hash(prompt), ...(bundled ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      ...(waitForCancel ? { WAIT_FOR_CANCEL: '1' } : {}) }, shellCommand: command, workspaceDir,
    state: { messages: [], isWorking: false, events: [], queue: [] } })
  return { manager, events, host }
}

async function waitFor(events: Array<{ event: string; payload: any }>, event: string) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const failure = events.find(item => item.event === 'run.failed')
    if (failure) throw new Error(JSON.stringify(failure))
    if (events.some(item => item.event === event)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`No ${event}: ${JSON.stringify(events)}`)
}

describe('native coding agent real platform child processes', () => {
  it.each([...acpAgents, 'zcode'].flatMap(agent => (agent === 'qoder' ? ['global'] : ['scoped', 'global']).map(mode => [agent, mode] as const)))(
    'runs %s in %s mode from non-ASCII paths through the real platform launcher', async (agent, mode) => {
      const prompt = agent === 'zcode' ? '检查中文工作区' : `中文 "quotes" & %PATH% ! ^\n${'超长输入'.repeat(5000)}`
      const { manager, events } = await setup(agent, mode as 'scoped' | 'global', prompt)
      try {
        manager.send('platform-session', prompt)
        await waitFor(events, 'run.completed')
        expect(events).toContainEqual(expect.objectContaining({ event: 'message.delta',
          payload: expect.objectContaining({ delta: `fixture:${hash(prompt)}` }) }))
      } finally { manager.stop('platform-session', { reportClosed: false }) }
    }, 20_000,
  )

  it.each(['scoped', 'global'] as const)('preserves long multiline ZCode bundled prompts in %s mode', async mode => {
    const prompt = `中文 "quotes" & %PATH% ! ^\r\n${'超长输入'.repeat(5000)}`
    const { manager, events } = await setup('zcode', mode, prompt, true)
    try {
      manager.send('platform-session', prompt)
      await waitFor(events, 'run.completed')
      expect(events).toContainEqual(expect.objectContaining({ event: 'message.delta',
        payload: expect.objectContaining({ delta: `fixture:${hash(prompt)}` }) }))
    } finally { manager.stop('platform-session', { reportClosed: false }) }
  }, 20_000)

  it('stops a running native ACP child on the current OS', async () => {
    const { manager, events, host } = await setup('qwen', 'global', 'Wait', false, true)
    try {
      manager.send('platform-session', 'Wait')
      await waitFor(events, 'message.delta')
      const child = host.runs.get('platform-qwen').currentChild
      const closed = once(child, 'close')
      manager.stop('platform-session', { reportClosed: false })
      await closed
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    } finally { manager.stop('platform-session', { reportClosed: false }) }
  }, 20_000)

  it('executes the Windows ZCode stdin bridge with a real Node entrypoint', async () => {
    const prompt = `中文 "quotes" & %PATH% ! ^\r\n${'超长输入'.repeat(5000)}`
    const { manager, events } = await setup('zcode', 'global', prompt, true)
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      manager.send('platform-session', prompt)
      await waitFor(events, 'run.completed')
      expect(events).toContainEqual(expect.objectContaining({ event: 'message.delta',
        payload: expect.objectContaining({ delta: `fixture:${hash(prompt)}` }) }))
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform)
      manager.stop('platform-session', { reportClosed: false })
    }
  }, 20_000)
})
