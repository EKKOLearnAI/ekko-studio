import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const executable = resolve(process.argv[2] || '')
const resources = process.argv[3] && resolve(process.argv[3])
if (!process.argv[2] || !resources) {
  throw new Error('Usage: node scripts/verify-desktop-mcp.mjs <packaged executable> <resources directory>')
}
const state = await mkdtemp(join(tmpdir(), 'hermes-desktop-mcp-'))
try {
  for (const scriptName of ['ekko-studio-mcp.mjs', 'hermes-studio-mcp.mjs', 'hermes-web-ui-mcp.mjs']) {
    for (const toolset of ['api', 'browser', 'devices', 'use', 'plan', 'interaction']) {
      const env = {
        ...process.env,
        HERMES_WEB_UI_HOME: state,
        HERMES_WEBUI_STATE_DIR: state,
        HERMES_HOME: state,
      }
      delete env.ELECTRON_RUN_AS_NODE
      const child = spawn(executable, [join(resources, 'webui', 'bin', scriptName), toolset], {
        env, stdio: ['pipe', 'pipe', 'pipe'],
      })
      let output = ''
      let stderr = ''
      child.stdout.on('data', chunk => { output += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
      try {
        const closed = new Promise((resolveClose, reject) => {
          child.once('error', reject)
          child.once('close', (code, signal) => resolveClose({ code, signal }))
        })
        child.stdin.end(JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'desktop-regression', version: '1' } },
        }) + '\n')
        const result = await closed
        assert.equal(result.code, 0, `${toolset} exit: ${JSON.stringify(result)} ${stderr}`)
        const messages = output.trim().split('\n').map(line => JSON.parse(line))
        assert.equal(messages.length, 1, `Unexpected GUI or updater output: ${output}`)
        assert.equal(messages[0].id, 1)
        assert.ok(messages[0].result?.serverInfo)
        console.log(`PASS ${scriptName} ${toolset}: packaged MCP initializes without ELECTRON_RUN_AS_NODE and exits on stdin EOF`)
      } finally {
        clearTimeout(timer)
      }
    }
  }
} finally {
  await rm(state, { recursive: true, force: true })
}
