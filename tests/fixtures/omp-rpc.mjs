#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
if (process.argv.includes('--version')) { console.log('18.19.0'); process.exit(0) }
const directory = process.env.PI_CODING_AGENT_DIR
const models = JSON.parse(readFileSync(join(directory, 'models.yml'), 'utf8'))
const model = Object.entries(models.providers).flatMap(([provider, value]) => value.models.map(model => ({ ...model, provider })))[0]
const flag = name => process.argv[process.argv.indexOf(name) + 1]
const sessions = process.argv.includes('--session-dir') ? flag('--session-dir') : directory
mkdirSync(sessions, { recursive: true })
const sessionFile = process.argv.includes('--resume') ? flag('--resume') : join(sessions, 'fixture.jsonl')
let turns = existsSync(sessionFile) ? Number(readFileSync(sessionFile, 'utf8')) || 0 : 0
writeFileSync(sessionFile, String(turns))
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
send({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576 })
send({ type: 'extension_ui_request', id: 'startup-secret', method: 'input', title: 'Private input', secret: true })
createInterface({ input: process.stdin }).on('line', line => {
  const command = JSON.parse(line), response = data => send({ type: 'response', id: command.id, command: command.type, success: true, data })
  if (command.type === 'get_available_models') response({ models: model ? [model] : [] })
  else if (command.type === 'get_state') response({ sessionFile, model })
  else if (command.type === 'prompt') {
    response({ agentInvoked: true })
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'preview' } })
    if (command.message === 'hold') return
    const text = `fixture turn ${++turns}; images=${command.images?.length || 0}; model=${model.provider}/${model.id}`
    writeFileSync(sessionFile, String(turns))
    send({ type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read', args: { path: 'fixture.txt' } })
    send({ type: 'tool_execution_end', toolCallId: 'read-1', result: { text: 'x'.repeat(110000) }, isError: false })
    send({ type: 'message_end', messageId: `reply-${turns}`, message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', usage: { input: 12, output: 5, cacheRead: 2, cost: { total: 0.01 } } } })
    send({ type: 'agent_end', messages: [], isTerminal: true, yielded: true })
    send({ type: 'prompt_result', id: command.id, status: 'completed', agentInvoked: true, sessionSettled: true })
    send({ type: 'session_settled' })
  } else response({})
})
