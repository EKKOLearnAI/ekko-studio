import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, stringify } from 'smol-toml'
import { directories, readOptional } from './configuration'
import { StudioError, nativeAgentLaunch, nativeAgentLogin, nativeAgentSetup, type AgentManagementAdapter } from '@ekko-studio/plugin-sdk'
import { locations } from './resources'
const setup = nativeAgentSetup('grok', '@xai-official/grok@1.0.70', ['login'])
export const management: AgentManagementAdapter = {
  prepareInstall: async () => ({ kind: 'npm', packageName: '@xai-official/grok', version: '1.0.70', bin: 'grok', runner: process.platform === 'win32' ? 'node' : 'binary', nativeHomeEnv: ['GROK_HOME'] }),
  setup, locations, prepareLogin: nativeAgentLogin('grok', ['login']),
  async inspect(input, context) {
    if (input.mode === 'scoped') throw new StudioError('CAPABILITY_UNSUPPORTED', 'Scoped Grok inspection requires a model-bound context')
    const temporary = await mkdtemp(join(tmpdir(), 'studio-grok-inspection-')), home = join(temporary, 'home'), native = join(temporary, 'native')
    try {
      await mkdir(home, { mode: 0o700 }); await mkdir(native, { mode: 0o700 })
      const { source } = directories(input.config, context), settings = parse(await readOptional(join(source, 'config.toml')))
      // `models` bootstraps its Home. Inventory requires neither native auth nor account refresh.
      const models = settings.model && typeof settings.model === 'object' && !Array.isArray(settings.model) ? settings.model : {}
      const catalog = Object.fromEntries(Object.entries(models).map(([id, value]) => [id,
        value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => !['api_key', 'env_key', 'extra_headers', 'headers', 'access_token', 'refresh_token', 'auth_token'].includes(key))) : value]))
      await writeFile(join(native, 'config.toml'), stringify({ ...(settings.models ? { models: settings.models } : {}), model: catalog, cli: { auto_update: false } }), { mode: 0o600 })
      const inherited = Object.fromEntries(Object.entries(input.config.env as Record<string, string> || {}).filter(([key]) => !/KEY|TOKEN|AUTH|COOKIE|PASSWORD|SECRET/i.test(key)))
      const config = { ...input.config, cwd: temporary, env: { ...inherited, HOME: home, USERPROFILE: home, GROK_HOME: native, GROK_DISABLE_AUTOUPDATER: '1' } }
      const version = await setup({ ...input, config }, context)
      if (version.cli.state !== 'available') throw new StudioError('RUNTIME_UNAVAILABLE', 'Grok is unavailable')
      const launch = nativeAgentLaunch('grok', config, context)
      const handle = await context.processes.spawn({ command: launch.command, args: [...launch.args, 'models'], cwd: String(config.cwd), env: config.env })
      const abort = () => { void handle.dispose().catch(() => {}) }; context.signal.addEventListener('abort', abort, { once: true })
      try {
        let stdout = '', bytes = 0
        const decoder = new TextDecoder('utf-8', { fatal: true })
        while (true) {
          if (context.signal.aborted) throw new StudioError('CANCELLED', 'Grok inspection cancelled')
          const batch = await handle.read()
          for (const chunk of batch.chunks) { bytes += chunk.data.length; if (chunk.stream === 'stdout') stdout += decoder.decode(chunk.data, { stream: true }) }
          if (batch.truncated || bytes > 262144) throw new StudioError('RESOURCE_EXHAUSTED', 'Grok model catalog is too large')
          if (batch.exit && !batch.chunks.length) { if (batch.exit.code !== 0) throw new StudioError('RUNTIME_UNAVAILABLE', 'Grok model inspection failed'); break }
        }
        const models = stdout.split(/\r?\n/).flatMap(line => {
          const match = /^\s*[*-]\s+([\w][\w./:@+-]{0,255})(.*)$/.exec(line)
          return match ? [{ id: match[1], name: match[1], isDefault: /\(default\)/i.test(match[2]) }] : []
        })
        if (models.length > 512) throw new StudioError('RESOURCE_EXHAUSTED', 'Grok model catalog is too large')
        if (!models.length && !/Available models:|No models/i.test(stdout)) throw new StudioError('INVALID_ARGUMENT', 'Unrecognized Grok model catalog')
        return { native: { name: 'Grok', version: version.cli.version }, authentication: { state: 'unknown', methods: [{ id: 'grok-login', name: 'Grok login' }] }, models: { status: 'available', items: models } }
      } finally { context.signal.removeEventListener('abort', abort); await handle.dispose() }
    } finally { await rm(temporary, { recursive: true, force: true }) }
  },
}
