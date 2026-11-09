import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { prepareDshWebProfile } from './web-profile'
import { prepareDshRuntime } from './runtime-config'
import { killOwnedProcessTree } from '../../../studio/public/process-tree'
import { DshPluginError } from './errors'

interface Host {
  sourceHome?: string
  env: NodeJS.ProcessEnv
  commandExecution(command: string, args: string[]): { command: string; args: string[]; windowsVerbatimArguments?: boolean }
}
/** Exercise composition, dependency identity, native imports and ACP startup.
 * The clean source home excludes user plugins and credential files. No prompt
 * is sent; the subprocess uses Studio's normal toolchain environment. */
export async function preflightDsh(command: string, scratchParent: string, host: Host): Promise<void> {
  await mkdir(scratchParent, { recursive: true })
  const root = await mkdtemp(join(scratchParent, 'preflight-'))
  try {
    const prepared = await prepareDshRuntime({ installationCommand: command, sourceHome: join(root, 'source'),
      sharedSkills: join(root, 'skills'), rootDir: join(root, 'runtime'), systemPrompt: '', managedMcp: {} })
    if (host.sourceHome) await prepareDshWebProfile({ command, sourceHome: host.sourceHome, rootDir: join(root, 'configured') })
    const execution = host.commandExecution(command, prepared.args)
    const child = spawn(execution.command, execution.args, { cwd: root, windowsHide: true, detached: process.platform !== 'win32',
      windowsVerbatimArguments: execution.windowsVerbatimArguments,
      env: { ...host.env, ...prepared.env, DSH_TELEMETRY_DISABLED: '1', ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
    try {
      await new Promise<void>((resolve, reject) => {
        let output = ''
        const timeout = setTimeout(() => finish(new Error('ACP initialize timed out')), 30_000)
        let settled = false
        function finish(error?: Error) { if (settled) return; settled = true; clearTimeout(timeout); error ? reject(error) : resolve() }
        child.once('error', () => finish(new Error('ACP process could not start')))
        child.once('close', code => finish(new Error(`ACP exited before initialize (${code})`)))
        child.stderr.resume() // Native logs can contain private configuration.
        child.stdin.on('error', () => finish(new Error('ACP input closed')))
        child.stdout.on('data', chunk => {
          output += String(chunk)
          if (output.length > 1024 * 1024) return finish(new Error('ACP output exceeded limit'))
          let newline: number
          while ((newline = output.indexOf('\n')) >= 0) {
            const line = output.slice(0, newline); output = output.slice(newline + 1)
            try {
              const reply = JSON.parse(line)
              if (reply.id === 1) finish(reply.result?.protocolVersion === 1 ? undefined : new Error('ACP initialize was rejected'))
            } catch { /* CLI startup messages are not protocol responses. */ }
          }
        })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
          protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'studio-preflight', version: '1' },
        } }) + '\n')
      })
    } finally {
      if (child.pid && child.exitCode === null && child.signalCode === null) await killOwnedProcessTree(child.pid, () => child.kill('SIGKILL'))
      await closed
    }
  } catch (error: any) {
    throw new DshPluginError(422, 'DSH_CAPABILITY_UNSUPPORTED', `DSH compatibility preflight failed: ${error.message}`)
  } finally { await rm(root, { recursive: true, force: true }) }
}
