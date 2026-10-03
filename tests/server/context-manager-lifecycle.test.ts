import { createServer, type Server } from 'node:net'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const home = vi.hoisted(() => ({ value: '' }))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ config: { get appHome() { return home.value } } }))
let server: Server | undefined
beforeEach(async () => { home.value = await mkdtemp(join(tmpdir(), 'context-lifecycle-')) })
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
  server = undefined
  await rm(home.value, { recursive: true, force: true })
})
async function load() { return import('../../packages/server/src/modules/studio/services/context-manager/lifecycle') }

describe('context manager lifecycle ownership', () => {
  it('isolates paths and subprocess environment from global bili and Hermes state', async () => {
    const { contextManagerPaths, contextManagerEnvironment } = await load()
    const a = contextManagerPaths('default'), b = contextManagerPaths('../../research')
    expect(a.root).not.toBe(b.root)
    expect(b.root.startsWith(home.value)).toBe(true)
    const env = contextManagerEnvironment(a, { ...process.env, BILI_SESSIONS_DIR: '/global', ACP_DEBUG: '1', BILI_PARENT_PID: '99', NODE_OPTIONS: '--inspect', NPM_CONFIG_PREFIX: '/global' })
    expect(env.BILI_SESSIONS_DIR).toBe(join(a.root, 'data', 'billion-context', 'sessions'))
    expect(env.ACP_DEBUG).toBeUndefined()
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.NPM_CONFIG_PREFIX).toBeUndefined()
    expect(env.BILI_PARENT_PID).toBe(String(process.pid))
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
  })
  it('reports an occupied port as externally managed and never stops it', async () => {
    server = createServer()
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const { saveContextManagerSettings } = await import('../../packages/server/src/modules/studio/services/context-manager/settings')
    await saveContextManagerSettings('default', { proxyUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` })
    const { getContextManagerLifecycleState, runContextManagerLifecycle } = await load()
    expect(await getContextManagerLifecycleState('default')).toMatchObject({ management: 'external', running: true })
    for (const action of ['start', 'stop', 'upgrade']) {
      await expect(runContextManagerLifecycle('default', 'ekko', action)).rejects.toMatchObject({ status: 409, code: 'context_manager_externally_managed' })
    }
    expect(server.listening).toBe(true)
  })
  it('rejects unknown actions and holds a filesystem single-writer lock', async () => {
    const { contextManagerPaths, runContextManagerLifecycle } = await load()
    await expect(runContextManagerLifecycle('default', 'ekko', 'start; killall node')).rejects.toMatchObject({ status: 400 })
    await mkdir(join(contextManagerPaths('default').root, '.writer'), { recursive: true })
    await expect(runContextManagerLifecycle('default', 'ekko', 'install')).rejects.toMatchObject({ status: 409, code: 'context_manager_busy' })
  })
  it('starts and stops only its own installed child with fixed bili CLI arguments', async () => {
    const { contextManagerPaths, runContextManagerLifecycle, getManagedContextManagerCaBundle } = await load()
    const paths = contextManagerPaths('test')
    const release = '11111111-1111-4111-8111-111111111111'
    const pkg = join(paths.root, 'releases', release, 'node_modules', 'billion-context')
    await mkdir(join(pkg, 'dist'), { recursive: true })
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'billion-context', version: '0.1.181' }))
    await writeFile(join(pkg, 'dist', 'index.js'), `const fs = require('node:fs'); const http = require('node:http'); fs.writeFileSync(process.env.ARGS_FILE, JSON.stringify(process.argv.slice(2))); const args = process.argv; const s = http.createServer((req,res) => { res.setHeader('content-type','application/json'); res.end(JSON.stringify({version:'0.1.181'})); }); s.listen(Number(args[args.indexOf('--port')+1]), args[args.indexOf('--host')+1]); process.on('SIGTERM',()=>s.close(()=>process.exit(0)));`)
    await writeFile(paths.activeFile, JSON.stringify({ release }))
    const argsFile = join(paths.root, 'args.json')
    vi.stubEnv('ARGS_FILE', argsFile)
    const spare = createServer()
    await new Promise<void>(resolve => spare.listen(0, '127.0.0.1', resolve))
    const port = (spare.address() as { port: number }).port
    await new Promise<void>(resolve => spare.close(() => resolve()))
    const { saveContextManagerSettings } = await import('../../packages/server/src/modules/studio/services/context-manager/settings')
    await saveContextManagerSettings('test', { proxyUrl: `http://127.0.0.1:${port}` })
    try {
      expect(getManagedContextManagerCaBundle('test', `http://127.0.0.1:${port}`)).toBeUndefined()
      expect(await runContextManagerLifecycle('test', 'ekko', 'start')).toMatchObject({ status: 'started', lifecycle: { management: 'studio', running: true } })
      expect(getManagedContextManagerCaBundle('test', `http://127.0.0.1:${port}`)).toBe(join(paths.root, 'data', 'billion-context', 'ca', 'combined-ca.pem'))
      expect(getManagedContextManagerCaBundle('other', `http://127.0.0.1:${port}`)).toBeUndefined()
      expect(getManagedContextManagerCaBundle('test', 'http://127.0.0.1:1')).toBeUndefined()
      expect(JSON.parse(await readFile(argsFile, 'utf8'))).toEqual(['start', '--config', paths.configFile, '--host', '127.0.0.1', '--port', String(port), '--no-auto-update'])
      expect(await runContextManagerLifecycle('test', 'hermes', 'stop')).toMatchObject({ status: 'stopped', lifecycle: { running: false } })
      expect(getManagedContextManagerCaBundle('test', `http://127.0.0.1:${port}`)).toBeUndefined()
    } finally {
      await runContextManagerLifecycle('test', 'ekko', 'stop').catch(() => {})
      vi.unstubAllEnvs()
    }
  })
})