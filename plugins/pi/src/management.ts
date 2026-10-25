import { StudioError, nativeAgentLaunch, nativeAgentLogin, nativeAgentSetup, type AgentManagementAdapter } from '@ekko-studio/plugin-sdk'
import { locations } from './resources'

const setup = nativeAgentSetup('pi', '@earendil-works/pi-coding-agent@1.4.0', [], '/login')
export const management: AgentManagementAdapter = {
  locations, setup, prepareLogin: nativeAgentLogin('pi', []),
  prepareInstall: async () => ({ kind: 'npm', packageName: '@earendil-works/pi-coding-agent', version: '1.4.0', bin: 'pi', runner: 'node' }),
  async inspect(input, context) {
    if (input.mode === 'scoped') throw new StudioError('CAPABILITY_UNSUPPORTED', 'Scoped inspection requires a model-bound management context')
    const version = await setup(input, context)
    if (version.cli.state !== 'available') throw new StudioError('RUNTIME_UNAVAILABLE', 'Pi is unavailable')
    const launch = nativeAgentLaunch('pi', input.config, context)
    const handle = await context.processes.spawn({ command: launch.command, args: [...launch.args, '--offline', '--list-models'], cwd: String(input.config.cwd),
      env: { ...input.config.env as Record<string, string>, PI_OFFLINE: '1', PI_TELEMETRY: '0' } })
    const abort = () => { void handle.dispose().catch(() => {}) }
    context.signal.addEventListener('abort', abort, { once: true })
    try {
      let stdout = '', bytes = 0
      while (true) {
        if (context.signal.aborted) throw new StudioError('CANCELLED', 'Pi inspection cancelled')
        const batch = await handle.read()
        for (const chunk of batch.chunks) { bytes += chunk.data.length; if (chunk.stream === 'stdout') stdout += Buffer.from(chunk.data).toString() }
        if (batch.truncated || bytes > 262144) throw new StudioError('RESOURCE_EXHAUSTED', 'Pi model catalog is too large')
        if (batch.exit && !batch.chunks.length) { if (batch.exit.code !== 0) throw new StudioError('RUNTIME_UNAVAILABLE', 'Pi model inspection failed'); break }
      }
      const models = stdout.split(/\r?\n/).flatMap(line => {
        const fields = line.trim().split(/\s+/)
        if (fields.length < 6 || !/^\d+(?:\.\d+)?[km]?$/i.test(fields[2]) || !/^\d+(?:\.\d+)?[km]?$/i.test(fields[3]) || !['yes', 'no'].includes(fields[4])) return []
        return [{ id: `${fields[0]}/${fields[1]}`, name: fields[1] }]
      })
      if (!models.length && !/No models (?:available|found)|provider\s+model\s+/i.test(stdout)) throw new StudioError('INVALID_ARGUMENT', 'Unrecognized Pi model catalog')
      if (models.length > 512) throw new StudioError('RESOURCE_EXHAUSTED', 'Pi model catalog is too large')
      return { native: { name: 'Pi', version: version.cli.version }, authentication: { state: 'unknown', methods: [{ id: 'pi-login', name: 'Pi /login' }] },
        models: { status: 'available', items: models } }
    } finally { context.signal.removeEventListener('abort', abort); await handle.dispose() }
  },
}
