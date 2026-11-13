import { mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { killOwnedProcessTree } from '../../../studio/public/process-tree'
import { DshPluginError } from './errors'
import { DshManagement } from './management'
import { DshAgentPresetService } from './agent-presets'
import { DshUiGateway } from './ui-gateway'
import { changeNativeDshPlugins } from './plugins'
import { readNativeDshPluginInventory } from './plugin-inventory'

interface DshHostCommands {
  commandEnv(): Promise<NodeJS.ProcessEnv>
  findCommandPaths(command: string, env: NodeJS.ProcessEnv): Promise<string[]>
  resolveCommandForExecution(command: string, env: NodeJS.ProcessEnv): Promise<string>
  commandExecution(command: string, args: string[]): { command: string; args: string[]; windowsVerbatimArguments?: boolean }
  getSourceHome(): string
}

/** DSH behavior stays here; the agent registry supplies only platform helpers. */
export function createDshHost(host: DshHostCommands) {
  async function runtimeInput() {
    const env = await host.commandEnv()
    const discovered = (await host.findCommandPaths('dsh', env))[0]
    if (!discovered) throw new DshPluginError(503, 'DSH_DEPENDENCY_UNAVAILABLE', 'DSH is not installed')
    // Windows lookup can return npm's Unix shim before dsh.cmd. Use the shared
    // execution resolver there; POSIX discovery still needs an absolute path.
    const command = process.platform === 'win32' ? await host.resolveCommandForExecution('dsh', env) : discovered
    return { installationCommand: command, launchPath: env.PATH,
      sourceHome: process.env.DSH_HOME?.trim() || host.getSourceHome() }
  }
  async function getNativeDshPluginInventory() {
    // Unlike spawn, filesystem discovery needs an absolute executable path on
    // every platform. host.resolveCommandForExecution intentionally leaves POSIX
    // commands bare, so use the same PATH lookup as installation discovery.
    const commands = await host.findCommandPaths('dsh', await host.commandEnv())
    const command = commands[0]
    if (!command) throw new DshPluginError(503, 'DSH_DEPENDENCY_UNAVAILABLE', 'DSH is not installed')
    return readNativeDshPluginInventory(command, process.env.DSH_HOME?.trim() || host.getSourceHome())
  }

  /** Native package commands target the source Web profile with validated argv. */
  async function executeDshPluginCommand(home: string, args: string[], signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    await mkdir(home, { recursive: true })
    const env = await host.commandEnv()
    const command = await host.resolveCommandForExecution('dsh', env)
    const execution = host.commandExecution(command, args)
    await new Promise<void>((resolve, reject) => {
      const child = spawn(execution.command, execution.args, {
        cwd: home, detached: process.platform !== 'win32', windowsHide: true,
        ...('windowsVerbatimArguments' in execution ? { windowsVerbatimArguments: true } : {}),
        env: { ...env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      let timedOut = false
      child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-32_768) })
      const stop = () => killOwnedProcessTree(child.pid, () => {
        try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      })
      const timeout = setTimeout(() => { timedOut = true; stop() }, 300_000)
      const cleanup = () => { clearTimeout(timeout); signal.removeEventListener('abort', stop) }
      signal.addEventListener('abort', stop, { once: true })
      if (signal.aborted) stop()
      child.once('error', () => { cleanup(); reject(new DshPluginError(503, 'DSH_DEPENDENCY_UNAVAILABLE', 'DSH or its package manager is unavailable')) })
      child.once('close', code => {
        cleanup()
        if (signal.aborted) reject(new DshPluginError(503, 'DSH_OPERATION_INTERRUPTED', 'Plugin operation interrupted'))
        else if (timedOut) reject(new DshPluginError(503, 'DSH_OPERATION_TIMEOUT', 'Plugin operation timed out'))
        else if (code === 0) resolve()
        else if (/pnpm not found|ENOENT/.test(stderr)) reject(new DshPluginError(503, 'DSH_DEPENDENCY_UNAVAILABLE', 'Install DSH and pnpm before managing plugins'))
        else reject(new DshPluginError(422, 'DSH_PLUGIN_OPERATION_FAILED', 'Web plugin operation failed; reload the list to inspect its current state'))
      })
    })
  }

  const management = new DshManagement({ runtimeInput, commandEnv: host.commandEnv, commandExecution: host.commandExecution })
  const ui = new DshUiGateway(management)
  async function changePlugins(body: unknown, revision: string) {
    const input = await runtimeInput()
    await management.close()
    try { await changeNativeDshPlugins({ command: input.installationCommand, sourceHome: input.sourceHome, body, revision, execute: executeDshPluginCommand }) }
    finally { await management.close() }
    return getNativeDshPluginInventory()
  }
  return { getNativeDshPluginInventory, executeDshPluginCommand, runtimeInput, management, ui, changePlugins, presets: new DshAgentPresetService(management) }
}
