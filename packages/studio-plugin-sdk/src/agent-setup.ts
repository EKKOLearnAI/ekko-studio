import { StudioError } from './errors'
import type { AgentManagementAdapter, AgentSetup, AgentRuntimeContext, JsonObject } from './types'

export function nativeAgentLaunch(defaultCommand: string, config: JsonObject, context: Pick<AgentRuntimeContext, 'nativeCli'>): { command: string; args: string[] } {
  const args = config.args as string[] || []
  if (config.command) return { command: String(config.command), args: [...args] }
  if (context.nativeCli?.state === 'unavailable') throw new StudioError('RUNTIME_UNAVAILABLE', 'Managed CLI requires installation repair')
  if (context.nativeCli?.state === 'ready') return { command: context.nativeCli.command, args: [...context.nativeCli.args, ...args] }
  return { command: defaultCommand, args: [...args] }
}

/** Launch details stay between the plugin and host; clients only receive an operation receipt. */
export function nativeAgentLogin(defaultCommand: string, loginArgs: string[]): NonNullable<AgentManagementAdapter['prepareLogin']> {
  return async ({ config, mode }, context) => {
    if (mode !== 'global') throw new StudioError('CAPABILITY_UNSUPPORTED', 'Scoped instances use Studio credentials')
    const launch = nativeAgentLaunch(defaultCommand, config, context)
    return { command: launch.command, args: [...launch.args, ...loginArgs],
      cwd: String(config.cwd), ...(config.env ? { env: config.env as Record<string, string> } : {}) }
  }
}

/** Version probes discard native output except a bounded version identifier. */
export function nativeAgentSetup(defaultCommand: string, packageSpec: string | { kind: 'manual'; url: string }, loginArgs: string[], loginInput?: string): NonNullable<AgentManagementAdapter['setup']> {
  return async ({ config, mode }, context) => {
    const unavailable = !config.command && context.nativeCli?.state === 'unavailable'
    const { command, args } = unavailable ? { command: defaultCommand, args: config.args as string[] || [] } : nativeAgentLaunch(defaultCommand, config, context)
    const result: AgentSetup = {
      cli: { state: 'unavailable' }, installation: typeof packageSpec === 'string'
        ? { command: 'npm', args: ['install', '--global', packageSpec] } : { ...packageSpec },
      authentication: mode === 'scoped' ? { kind: 'studio' } : { kind: 'native', command, args: [...args, ...loginArgs], ...(loginInput ? { input: loginInput } : {}) },
    }
    if (unavailable) return result
    let process: import('./types').ProcessHandle | undefined
    try {
      process = await context.processes.spawn({ command, args: [...args, '--version'], cwd: String(config.cwd), ...(config.env ? { env: config.env as Record<string, string> } : {}) })
      let output = '', bytes = 0
      const decoder = new TextDecoder()
      while (true) {
        if (context.signal.aborted) throw new StudioError('CANCELLED', 'Setup check ended')
        const batch = await process.read()
        for (const chunk of batch.chunks) {
          bytes += chunk.data.length
          if (bytes > 16_384 || batch.truncated) throw new StudioError('RESOURCE_EXHAUSTED', 'Version output limit exceeded')
          if (chunk.stream === 'stdout') output += decoder.decode(chunk.data, { stream: true })
        }
        if (batch.exit && !batch.chunks.length) {
          if (batch.exit.code === 0) {
            const version = output.match(/\b\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?\b/)?.[0]
            result.cli = { state: 'available', ...(version ? { version } : {}) }
          }
          return result
        }
      }
    } catch (error) {
      if (context.signal.aborted || !(error instanceof StudioError) || error.code !== 'RUNTIME_UNAVAILABLE') throw error
      return result
    } finally { await process?.dispose() }
  }
}
