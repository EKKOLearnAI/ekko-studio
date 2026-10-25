const fs = require('node:fs'),
  path = require('node:path')
if (process.argv.includes('--version')) {
  console.log('1.4.7')
  process.exit(0)
}
const chunks = []
process.stdin.on('data', (b) => chunks.push(b))
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n')
process.stdin.on('end', () => {
  const body = JSON.parse(Buffer.concat(chunks).toString()),
    prompt = body.message.content
  fs.appendFileSync(
    process.env.TRACE,
    JSON.stringify({
      args: process.argv.slice(2),
      body,
      home: process.env.HOME,
      token: process.env.GEMINI_API_KEY,
      base: process.env.GOOGLE_GEMINI_BASE_URL,
    }) + '\n',
  )
  const conversation = prompt === 'wrong-identity' ? 'other-session' : 'native-session'
  send({ event: 'init', conversation_id: conversation, init: { model: 'native-model' } })
  if (prompt === 'crash') process.exit(7)
  if (prompt.startsWith('wait')) {
    setInterval(() => {}, 1000)
    return
  }
  if (prompt === 'malformed') {
    process.stdout.write('{broken\n')
    setInterval(() => {}, 1000)
    return
  }
  const step = {
    event: 'step_update',
    step_update: {
      conversation_id: conversation,
      step_index: 1,
      step_type: 'agent_response',
      state: 'DONE',
      text_delta: prompt === 'usage-only' ? '' : 'Antigravity answer',
      usage: { input_tokens: 10, output_tokens: 3, cache_read_tokens: 2, thinking_tokens: 1 },
    },
  }
  send(step)
  send({ ...step, step_update: { ...step.step_update, text_delta: '' } })
  const tool = {
    event: 'step_update',
    step_update: {
      conversation_id: conversation,
      step_index: 2,
      step_type: 'tool',
      state: 'ERROR',
      tool_info: { name: 'view_file', parameters: { path: 'test' }, error: { message: 'denied' } },
    },
  }
  send(tool)
  send(tool)
  if (prompt === 'step-only') process.exit(0)
  const finish = () => {
    send({
      event: 'result',
      result: {
        conversation_id: conversation,
        status: prompt === 'error' ? 'ERROR' : 'SUCCESS',
        response: 'Antigravity answer',
        num_turns: 2,
        usage: { input_tokens: 999, output_tokens: 999 },
      },
    })
    if (prompt === 'bad-exit') process.exit(7)
    else if (prompt === 'late-exit') setInterval(() => {}, 1000)
    else process.exit(0)
  }
  if (prompt === 'barrier') {
    fs.writeFileSync(process.env.TRACE + '.step', 'ready')
    const timer = setInterval(() => {
      if (fs.existsSync(process.env.TRACE + '.release')) {
        clearInterval(timer)
        finish()
      }
    }, 20)
  } else finish()
})
