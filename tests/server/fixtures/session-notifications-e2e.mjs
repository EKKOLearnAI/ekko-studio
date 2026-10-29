#!/usr/bin/env node
// Real end-to-end harness for Studio session notifications.
//
// Starts, in disposable temp homes: a scripted fake OpenAI-compatible model, a foreground
// `hermes gateway run` (cron ticker), and the Studio server (real Agent Bridge). Drives two
// Studio sessions over Socket.IO with the user focused on session B, then checks the cron
// result and terminal completions land only in session A. Every child is stopped in finally.
//
//   npm run build && HERMES_AGENT_ROOT=<read-only hermes checkout> node tests/server/fixtures/session-notifications-e2e.mjs
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, createWriteStream, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { io } from 'socket.io-client'

const repo = resolve(new URL('../../..', import.meta.url).pathname)
const agentRoot = process.env.HERMES_AGENT_ROOT
if (!agentRoot) throw new Error('HERMES_AGENT_ROOT is required')
const python = join(agentRoot, 'venv', 'bin', 'python')
const hermesBin = join(agentRoot, 'venv', 'bin', 'hermes')
const evidenceDir = process.env.E2E_EVIDENCE_DIR || ''
const root = mkdtempSync('/tmp/esn-')
const dirs = Object.fromEntries(['home', 'hermes', 'studio', 'tmp', 'pyc', 'logs', 'uploads', 'bin'].map(name => [name, join(root, name)]))
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
// The only `hermes` on PATH is the pinned checkout's entry point; no other installation is discoverable.
symlinkSync(hermesBin, join(dirs.bin, 'hermes'))
const isolatedPath = [dirs.bin, dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':')

const results = []
const children = []
const record = (name, ok, detail = {}) => {
  results.push({ name, ok, ...detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${Object.keys(detail).length ? ' ' + JSON.stringify(detail).slice(0, 600) : ''}`)
}

// --- fake model -----------------------------------------------------------------------------------
const modelRequests = []
const modelLog = createWriteStream(join(dirs.logs, 'model.jsonl'))
const CRON_ANSWER = 'CRON_EXACT_ANSWER_42: the scheduled brief is ready.'
let toolCallSeq = 0
function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(part => (typeof part === 'string' ? part : part?.text || '')).join('\n')
  return ''
}
function decide(body) {
  const messages = body.messages || []
  const all = messages.map(m => textOf(m.content)).join('\n')
  const last = messages[messages.length - 1] || {}
  const lastUser = [...messages].reverse().find(m => m.role === 'user')
  const userText = textOf(lastUser?.content)
  const offered = new Set((body.tools || []).map(t => t.function?.name))
  // Deferred tools are invoked through Hermes' tool_call bridge, as a real model would.
  const tool = (name, args) => (offered.has(name) || !offered.has('tool_call')
    ? { tool: { id: `call_${++toolCallSeq}`, name, args } }
    : { tool: { id: `call_${++toolCallSeq}`, name: 'tool_call', args: { calls: [{ name, arguments: args }] } } })
  // The cron run's own user turn carries the job prompt; chat history only quotes it in tool arguments.
  if (userText.includes('E2E_CRON_PROMPT')) return { text: CRON_ANSWER }
  // Auxiliary calls (titles, summaries) offer no tools.
  if (!(body.tools || []).length) return { text: 'OK' }
  if (userText.includes('[IMPORTANT: Background process') || userText.includes('Background process')) {
    return { text: 'MACHINE_ACK' }
  }
  if (last.role === 'tool') {
    const calledProcess = messages.some(m => (m.tool_calls || []).some(c => c.function?.name === 'process_manage'
      || String(c.function?.arguments || '').includes('process_manage')))
    if (userText.includes('E2E_TERMINAL_WAIT') && !calledProcess) {
      let started = {}
      try { started = JSON.parse(textOf(last.content) || '{}') } catch {}
      return tool('process_manage', { action: 'wait', session_id: started.session_id, timeout: 30 })
    }
    return { text: 'TOOL_DONE' }
  }
  const in1m = new Date(Date.now() + 75_000).toISOString()
  if (userText.includes('E2E_SCHEDULE_SLACK')) {
    return tool('cronjob_manage', { action: 'create', name: 'e2e-slack', prompt: 'E2E_CRON_PROMPT slack', schedule: in1m, deliver: 'slack:C123' })
  }
  if (userText.includes('E2E_SCHEDULE')) {
    return tool('cronjob_manage', { action: 'create', name: 'e2e-brief', prompt: 'E2E_CRON_PROMPT report the brief', schedule: in1m })
  }
  if (userText.includes('E2E_TERMINAL_OK')) return tool('terminal', { command: 'printf term-ok; exit 0', background: true, notify_on_complete: true })
  if (userText.includes('E2E_TERMINAL_FAIL')) return tool('terminal', { command: 'printf term-bad; exit 3', background: true, notify_on_complete: true })
  if (userText.includes('E2E_TERMINAL_SILENT')) return tool('terminal', { command: 'printf quiet; exit 0', background: true, notify_on_complete: false })
  if (userText.includes('E2E_TERMINAL_WAIT')) return tool('terminal', { command: 'sleep 2; printf waited', background: true, notify_on_complete: true })
  return { text: 'OK' }
}
function completion(body, decision) {
  const message = decision.tool
    ? { role: 'assistant', content: null, tool_calls: [{ id: decision.tool.id, type: 'function', function: { name: decision.tool.name, arguments: JSON.stringify(decision.tool.args) } }] }
    : { role: 'assistant', content: decision.text }
  return {
    id: `chatcmpl-${randomUUID()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model || 'fake-model',
    choices: [{ index: 0, message, finish_reason: decision.tool ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }
}
function streamChunks(res, body, decision) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const id = `chatcmpl-${randomUUID()}`
  const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model || 'fake-model' }
  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`)
  if (decision.tool) {
    send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: decision.tool.id, type: 'function', function: { name: decision.tool.name, arguments: JSON.stringify(decision.tool.args) } }] }, finish_reason: null }] })
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
  } else {
    send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: decision.text }, finish_reason: null }] })
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
  }
  res.write('data: [DONE]\n\n')
  res.end()
}
const modelServer = createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model', context_length: 128000 }] }))
      return
    }
    let body = {}
    try { body = JSON.parse(raw || '{}') } catch {}
    const decision = decide(body)
    modelRequests.push({ at: Date.now(), messages: body.messages || [], decision })
    modelLog.write(`${JSON.stringify({ at: Date.now(), url: req.url, stream: Boolean(body.stream), tools: (body.tools || []).map(t => t.function?.name).slice(0, 80), last: body.messages?.slice(-2), decision })}\n`)
    if (body.stream) return streamChunks(res, body, decision)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(completion(body, decision)))
  })
})

// --- processes ------------------------------------------------------------------------------------
function baseEnv(extra = {}) {
  return {
    PATH: isolatedPath,
    HOME: dirs.home,
    // Reuse the checkout's read-only environment: no per-data-root dependency sync or update lock.
    HERMES_DISABLE_LAZY_INSTALLS: '1',
    TMPDIR: dirs.tmp,
    HERMES_HOME: dirs.hermes,
    // Bytecode is redirected into the temp tree (never the checkout) so warm imports fit Studio's probe timeout.
    PYTHONPYCACHEPREFIX: dirs.pyc,
    // The venv does not install the checkout's top-level `pm` package; import it from the read-only tree.
    // E2E_EXTRA_PYTHONPATH: disposable dir with pure-Python deps the pinned source needs but its legacy
    // venv lacks (e.g. snowballstemmer); never installed into the Hermes venv.
    PYTHONPATH: [agentRoot, process.env.E2E_EXTRA_PYTHONPATH].filter(Boolean).join(':'),
    ...extra,
  }
}
function startChild(name, command, args, env) {
  const log = createWriteStream(join(dirs.logs, `${name}.log`))
  const child = spawn(command, args, { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  child.stdout.pipe(log)
  child.stderr.pipe(log)
  children.push({ name, child })
  return child
}
async function stopChild(entry) {
  const { child } = entry
  if (child.exitCode !== null || child.signalCode) return
  try { process.kill(-child.pid, 'SIGTERM') } catch {}
  for (let i = 0; i < 50 && child.exitCode === null && !child.signalCode; i++) await delay(100)
  if (child.exitCode === null && !child.signalCode) { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
  for (let i = 0; i < 30 && child.exitCode === null && !child.signalCode; i++) await delay(100)
}

let port = 0
let studio = null
let token = ''
const studioEnv = () => baseEnv({
  NODE_ENV: 'production',
  PORT: String(port),
  HERMES_WEB_UI_HOME: dirs.studio,
  HERMES_WEBUI_STATE_DIR: dirs.studio,
  UPLOAD_DIR: dirs.uploads,
  HERMES_AGENT_ROOT: agentRoot,
  HERMES_BIN: join(dirs.bin, 'hermes'),
  HERMES_AGENT_BRIDGE_PYTHON: python,
  HERMES_AGENT_BRIDGE_ENDPOINT: `ipc://${join(root, 'b.sock')}`,
  HERMES_WEB_UI_DISABLE_GATEWAY_AUTOSTART: '1',
  HERMES_WEB_UI_MANAGED_GATEWAY: '0',
  // Hermes exposes cronjob_manage only when HERMES_EXEC_ASK/INTERACTIVE/GATEWAY_SESSION is set when the
  // agent is built; the bridge builds it before entering its exec-ask scope (pre-existing, see report).
  HERMES_EXEC_ASK: '1',
})
// Studio probes the Hermes CLI with a 5s timeout; re-warm that exact import right before each start.
const VERSION_PROBE = "import importlib.util, hermes_cli\nassert importlib.util.find_spec('hermes_cli.main')\nfrom hermes_cli.version_info import get_version_info\nprint(get_version_info().display_version)"
async function warmVersionProbe() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const started = Date.now()
    await new Promise(done => spawn(python, ['-c', VERSION_PROBE], { cwd: repo, env: baseEnv(), stdio: 'ignore' }).on('exit', done))
    if (Date.now() - started < 2500) return
  }
}
// Studio's 5s CLI probe can time out on a cold filesystem; retry the start until it discovers Hermes.
async function startStudio() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await startStudioOnce()
    const log = readFileSync(join(dirs.logs, `${children.find(item => item.child === studio).name}.log`), 'utf-8')
    if (/Hermes source=user-cli/.test(log)) return
    console.log(`studio start ${attempt}: Hermes runtime not discovered; retrying`)
    await stopStudio()
  }
  throw new Error('Studio did not discover the pinned Hermes runtime')
}
async function startStudioOnce() {
  await warmVersionProbe()
  // Runs the bundled server from `npm run build` (dist/server), which ships the bridge Python files.
  if (!existsSync(join(repo, 'dist', 'server', 'index.js'))) throw new Error('run `npm run build` first')
  studio = startChild(`studio-${children.length}`, process.execPath, ['--no-warnings', 'dist/server/index.js'], studioEnv())
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/status`)
      if (res.ok) return
    } catch {}
    if (studio.exitCode !== null) throw new Error('Studio exited during startup')
    await delay(500)
  }
  throw new Error('Studio did not start')
}
async function stopStudio() {
  const entry = children.find(item => item.child === studio)
  if (entry) await stopChild(entry)
}
async function api(path, init = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) },
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, json, text }
}
function connect() {
  return io(`http://127.0.0.1:${port}/chat-run`, { auth: { token }, query: { profile: 'default' }, transports: ['websocket'], reconnection: false })
}
function collect(socket) {
  const events = []
  socket.onAny((event, payload) => events.push({ event, payload, at: Date.now() }))
  return events
}
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await delay(250)
  }
  throw new Error(`timeout: ${label}`)
}
async function runTurn(socket, events, sessionId, input) {
  const start = events.length
  socket.emit('run', { session_id: sessionId, input, profile: 'default' })
  const done = await waitFor(() => events.slice(start).find(e => e.payload?.session_id === sessionId && (e.event === 'run.completed' || e.event === 'run.failed')), 180_000, `turn ${input}`)
  writeFileSync(join(dirs.logs, 'turns.jsonl'), `${JSON.stringify({ input, events: events.slice(start).map(e => ({ event: e.event, tool: e.payload?.tool, error: e.payload?.error, output: typeof e.payload?.output === 'string' ? e.payload.output.slice(0, 600) : undefined })) })}\n`, { flag: 'a' })
  return done
}
function jobs() {
  const file = join(dirs.hermes, 'cron', 'jobs.json')
  if (!existsSync(file)) return []
  const parsed = JSON.parse(readFileSync(file, 'utf-8'))
  return Array.isArray(parsed) ? parsed : parsed.jobs || []
}
function bindings() {
  const file = join(dirs.studio, 'session-notifications', 'cron-bindings.db')
  if (!existsSync(file)) return []
  const db = new DatabaseSync(file, { readOnly: true })
  try { return db.prepare('SELECT job_id, session_id, stored_deliver FROM cron_session_bindings').all() } finally { db.close() }
}
function studioRows(sql, ...params) {
  const db = new DatabaseSync(join(dirs.studio, 'hermes-web-ui.db'), { readOnly: true })
  try { return db.prepare(sql).all(...params) } finally { db.close() }
}

async function main() {
  await new Promise(done => modelServer.listen(0, '127.0.0.1', done))
  const modelPort = modelServer.address().port
  writeFileSync(join(dirs.hermes, 'config.yaml'), [
    'model:',
    '  default: fake-model',
    '  provider: custom',
    `  base_url: http://127.0.0.1:${modelPort}/v1`,
    '  api_key: fake-local-key',
    '  context_length: 128000',
    'compression:',
    '  enabled: false',
    '',
  ].join('\n'))
  const probe = createServer()
  await new Promise(done => probe.listen(0, '127.0.0.1', done))
  port = probe.address().port
  await new Promise(done => probe.close(done))

  await new Promise((done, fail) => {
    const warm = spawn(python, ['-c', 'import sys; sys.path.insert(0, sys.argv[1]); import hermes_cli.main, run_agent, tools.cronjob_tools, tools.terminal_tool, cron.scheduler', agentRoot],
      { cwd: repo, env: baseEnv(), stdio: 'ignore' })
    warm.on('exit', code => (code === 0 ? done() : fail(new Error(`warm-up import failed: ${code}`))))
  })
  startChild('gateway', join(dirs.bin, 'hermes'), ['gateway', 'run'], baseEnv())
  await startStudio()
  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: '123456' }) })
  token = login.json?.token
  if (!token) throw new Error(`login failed: ${login.text.slice(0, 200)}`)

  const A = `e2e-a-${randomUUID().slice(0, 8)}`
  const B = `e2e-b-${randomUUID().slice(0, 8)}`
  const owner = connect()
  const ownerEvents = collect(owner)
  await waitFor(() => owner.connected, 20_000, 'owner socket')

  // Session B exists and is the focused one.
  await runTurn(owner, ownerEvents, B, 'hello from B')
  // Chat-created cron job in A (omitted delivery).
  await runTurn(owner, ownerEvents, A, 'E2E_SCHEDULE please brief me')
  const created = jobs().find(job => job.name === 'e2e-brief')
  const bound = bindings().find(row => row.job_id === created?.id)
  record('chat create binds exact session before activation', Boolean(created && bound?.session_id === A && created.deliver === 'local' && created.enabled !== false && !created.origin),
    { deliver: created?.deliver, enabled: created?.enabled, bound })
  // Explicit target untouched and unbound.
  await runTurn(owner, ownerEvents, A, 'E2E_SCHEDULE_SLACK post it')
  const slack = jobs().find(job => job.name === 'e2e-slack')
  record('explicit delivery target unchanged and not bound', Boolean(slack && slack.deliver === 'slack:C123' && !bindings().some(row => row.job_id === slack.id)),
    { deliver: slack?.deliver })
  owner.disconnect()

  // The user now focuses only session B.
  const focus = connect()
  const focusEvents = collect(focus)
  await waitFor(() => focus.connected, 20_000, 'focus socket')
  focus.emit('resume', { session_id: B, profile: 'default' })
  const beforeFire = modelRequests.length
  const notice = await waitFor(() => focusEvents.find(e => e.event === 'session.notice' && e.payload?.session_id === A), 330_000, 'cron notice for A')
  const noticeContent = notice.payload.message?.content
  record('scheduled agent-backed fire delivers exact native result to A while B is focused',
    noticeContent === CRON_ANSWER && notice.payload.message?.studio_notice?.execution_id && notice.payload.attention === true,
    { content: noticeContent, execution_id: notice.payload.message?.studio_notice?.execution_id })
  record('no notice addressed to B', !focusEvents.some(e => e.event === 'session.notice' && e.payload?.session_id === B))
  await delay(3000)
  const afterFire = modelRequests.slice(beforeFire)
  record('passive cron result starts no LLM turn in A', afterFire.every(r => textOf(r.messages.map(m => textOf(m.content)).join('\n')).includes('E2E_CRON_PROMPT')),
    { requests_after_fire: afterFire.length })
  record('no run started for A by the cron notice', !focusEvents.some(e => e.event === 'run.started' && e.payload?.session_id === A))

  const pageA = await api(`/api/studio/sessions/conversations/${A}/messages/paginated?offset=0&limit=150`)
  const listed = (pageA.json?.messages || []).filter(m => m.studio_notice)
  const pageB = await api(`/api/studio/sessions/conversations/${B}/messages/paginated?offset=0&limit=150`)
  record('notice durable in A history and absent from B', listed.length === 1 && listed[0].content === CRON_ANSWER
    && !(pageB.json?.messages || []).some(m => m.studio_notice), { status: pageA.status, a: listed.length })
  const storedMessages = studioRows("SELECT count(*) AS n FROM messages WHERE session_id=? AND content LIKE '%CRON_EXACT_ANSWER_42%'", A)[0].n
  record('notice is not a model-history message row', storedMessages === 0)
  focus.disconnect()

  // Restart Studio: durable notice, no duplicate after replayed observation.
  await stopStudio()
  await startStudio()
  await delay(20_000)
  const afterRestart = await api(`/api/studio/sessions/conversations/${A}/messages/paginated?offset=0&limit=150`)
  const notices = studioRows("SELECT count(*) AS n FROM session_notifications WHERE session_id=? AND kind='cron' AND disposition='notified'", A)[0].n
  record('restart keeps exactly one durable notice (duplicate replay rejected)', notices === 1
    && (afterRestart.json?.messages || []).filter(m => m.studio_notice).length === 1, { notices })

  const actor = connect()
  const actorEvents = collect(actor)
  await waitFor(() => actor.connected, 20_000, 'actor socket')
  actor.emit('resume', { session_id: A, profile: 'default' })
  const q1Start = modelRequests.length
  await runTurn(actor, actorEvents, A, 'E2E_QUESTION what did the brief say?')
  const q1 = modelRequests.slice(q1Start).find(r => r.messages.some(m => textOf(m.content).includes('E2E_QUESTION')))
  const q1Text = q1 ? q1.messages.map(m => textOf(m.content)).join('\n') : ''
  const q2Start = modelRequests.length
  await runTurn(actor, actorEvents, A, 'E2E_QUESTION2 anything else?')
  const q2 = modelRequests.slice(q2Start).find(r => r.messages.some(m => textOf(m.content).includes('E2E_QUESTION2')))
  const q2Text = q2 ? q2.messages.map(m => textOf(m.content)).join('\n') : ''
  record('next intentional question sees the notice once, bounded', q1Text.includes('[Studio notifications') && q1Text.includes(CRON_ANSWER)
    && !q2Text.includes('[Studio notifications'))

  // Terminal completions.
  const machineTurns = () => modelRequests.filter(r => {
    const lastUser = [...r.messages].reverse().find(m => m.role === 'user')
    return textOf(lastUser?.content).includes('Background process')
  })
  const okStart = machineTurns().length
  await runTurn(actor, actorEvents, A, 'E2E_TERMINAL_OK run it')
  const okTurn = await waitFor(() => machineTurns().slice(okStart).find(r => JSON.stringify(r.messages).includes('term-ok')), 120_000, 'machine turn ok')
  const okHistory = okTurn.messages.map(m => textOf(m.content)).join('\n')
  record('terminal success re-enters A as a machine turn with current history', okHistory.includes('E2E_QUESTION2') && okHistory.includes('exit code 0'))
  await delay(3000)
  const machineRows = studioRows("SELECT role, display_role FROM messages WHERE session_id=? AND content LIKE '%term-ok%' AND role='user'", A)
  record('machine completion stored as model user turn displayed as system', machineRows.length === 1 && machineRows[0].display_role === 'system', { machineRows })

  const failStart = machineTurns().length
  await runTurn(actor, actorEvents, A, 'E2E_TERMINAL_FAIL run it')
  const failTurn = await waitFor(() => machineTurns().slice(failStart).find(r => JSON.stringify(r.messages).includes('term-bad')), 120_000, 'machine turn fail')
  record('terminal nonzero exit re-enters with failure outcome', JSON.stringify(failTurn.messages).includes('exit code 3'))

  const silentStart = machineTurns().length
  await runTurn(actor, actorEvents, A, 'E2E_TERMINAL_SILENT run it')
  await delay(15_000)
  record('notify_on_complete=false produces no machine turn', !machineTurns().slice(silentStart).some(r => JSON.stringify(r.messages).includes('quiet')))

  const waitStart = machineTurns().length
  await runTurn(actor, actorEvents, A, 'E2E_TERMINAL_WAIT run and wait')
  await delay(15_000)
  record('completion consumed by wait during the busy owner turn produces no machine turn',
    !machineTurns().slice(waitStart).some(r => JSON.stringify(r.messages).includes('waited')))
  const processRows = studioRows("SELECT disposition, count(*) AS n FROM session_notifications WHERE kind='process_completion' GROUP BY disposition")
  record('process completion dispositions recorded', processRows.some(row => row.disposition === 'dispatched'), { processRows })
  actor.disconnect()
}

let failure = null
try {
  await main()
} catch (error) {
  failure = error
  record('harness', false, { error: String(error?.stack || error).slice(0, 1500) })
} finally {
  for (const entry of [...children].reverse()) await stopChild(entry)
  await new Promise(done => modelServer.close(() => done()))
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true })
    writeFileSync(join(evidenceDir, 'e2e-results.json'), JSON.stringify({ results, model_requests: modelRequests.length }, null, 2))
    for (const name of ['model.jsonl', 'turns.jsonl', 'gateway.log', ...children.map(c => `${c.name}.log`)]) {
      const file = join(dirs.logs, name)
      if (existsSync(file)) writeFileSync(join(evidenceDir, `e2e-${name}`), readFileSync(file))
    }
  }
  rmSync(root, { recursive: true, force: true })
}
const failed = results.filter(item => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failure || failed.length ? 1 : 0)
