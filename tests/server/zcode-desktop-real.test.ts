import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { getCodingAgentDefinition, getCodingAgentStatus, prepareCodingAgentLaunch } from '../../packages/server/src/modules/coding-agents/services'
import { prepareNativeScopedRuntime } from '../../packages/server/src/modules/coding-agents/services/registry/native-agents'
import { resolveZcodeCommand } from '../../packages/server/src/modules/coding-agents/services/zcode/installation'

// Uses the installed desktop CLI with isolated state and a local model endpoint.
describe.skipIf(process.env.ZCODE_REAL_CLI_E2E !== '1')('real ZCode desktop CLI', () => {
  it.each(['global', 'scoped'] as const)('completes a %s turn with the matching provider configuration', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'ekko-zcode-real-'))
    const requests: any[] = []
    const server = createServer(async (request, response) => {
      let data = ''
      for await (const chunk of request) data += chunk.toString()
      const body = JSON.parse(data || '{}')
      if (request.url?.endsWith('/count_tokens')) {
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ input_tokens: 10 }))
        return
      }
      requests.push(body)
      const message = { id: 'msg-mock', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text: 'ZCODE_OK' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 3 } }
      if (!body.stream) {
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify(message))
        return
      }
      const events = [
        { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ZCODE_OK' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
        { type: 'message_stop' },
      ]
      response.setHeader('Content-Type', 'text/event-stream')
      response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
    })
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
      const workspace = join(root, 'workspace')
      await mkdir(workspace)
      vi.stubEnv('HERMES_WEB_UI_HOME', join(root, 'studio'))
      vi.stubEnv('HERMES_WEBUI_STATE_DIR', join(root, 'studio'))
      vi.stubEnv('HERMES_CODING_AGENT_GLOBAL_HOME', root)
      vi.stubEnv('ZCODE_DATA_BASE_DIR', root)
      vi.stubEnv('ZCODE_STORAGE_DIR', join(root, 'storage'))
      const runtime = await prepareNativeScopedRuntime({ agentId: 'zcode', rootDir: join(root, 'provider'),
        model: 'claude-sonnet-4-6', baseUrl, token: 'local-test-token', contextWindow: 128000, outputLimit: 8192 })
      if (mode === 'global') {
        // Seed only this temporary native home, leaving the real account untouched.
        const nativeDir = join(root, '.zcode', 'v2')
        await mkdir(nativeDir, { recursive: true })
        await copyFile(runtime.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, join(nativeDir, 'provider_config.json'))
      }
      const global = await prepareCodingAgentLaunch('zcode', { mode: 'global', workspace })
      expect(global.command).toBe(process.execPath)
      expect(global.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE).toContain('/config/provider/zcode-builtin.json')
      expect(global.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE).toBe(join(root, '.zcode', 'v2', 'provider_config.json'))
      const status = await getCodingAgentStatus(getCodingAgentDefinition('zcode')!)
      expect(status.installed, status.error).toBe(true)
      expect(status.path).toContain('zcode.cjs')
      const execution = mode === 'global' ? global
        : await resolveZcodeCommand(runtime.args, { ...process.env, ...runtime.env }, async () => [])
      const result = await run(execution.command, [...execution.args, '--output-format', 'stream-json', '--mode', 'plan', '-p', 'Reply ZCODE_OK only.'],
        workspace, { ...process.env, ...execution.env, ...(mode === 'scoped' ? runtime.env : {}) })
      expect(result.code, result.stderr + result.stdout).toBe(0)
      const events = result.stdout.trim().split('\n').map(line => JSON.parse(line))
      expect(events.find(event => event.type === 'result')?.response).toBe('ZCODE_OK')
      expect(result.stderr).not.toContain('无法定位 CLI')
      expect(requests.length).toBeGreaterThan(0)
      for (const request of requests) expect(request.model).toBe('claude-sonnet-4-6')
    } finally {
      vi.unstubAllEnvs()
      await close(server)
      await rm(root, { recursive: true, force: true })
    }
  }, 40_000)
})

async function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
  let stdout = ''
  let stderr = ''
  child.stdout!.on('data', chunk => { stdout += chunk.toString() })
  child.stderr!.on('data', chunk => { stderr += chunk.toString() })
  const timer = setTimeout(() => {
    if (process.platform !== 'win32' && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    } else child.kill('SIGKILL')
  }, 30_000)
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    return { code, stdout, stderr }
  } finally { clearTimeout(timer) }
}

async function close(server: Server) {
  if (!server.listening) return
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
