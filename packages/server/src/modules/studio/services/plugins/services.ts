import { isDeepStrictEqual } from 'node:util'
import { satisfies } from 'semver'
import { StudioError, type ExecutionContext, type JsonValue, type ServiceToken, type ServiceDependency } from '../../contracts/plugins'
import { compileSchema, jsonCopy, parseServiceToken } from './validation'

export type ServiceAuthority = (capability: string) => void
type Invoke = (context: ExecutionContext, method: string, input: JsonValue, authority: ServiceAuthority) => Promise<JsonValue>
interface Entry { token: ServiceToken; invoke: Invoke; available(): boolean; registration: object }

/** Only host-issued execution contexts cross the service boundary. */
export class PluginServiceRegistry {
  private readonly entries = new Map<string, Entry>()

  stage(profileId: string, declarations: readonly ServiceToken[], invoke: (id: string, ...args: Parameters<Invoke>) => ReturnType<Invoke>, available: () => boolean) {
    const registration = {}, pending = new Map<string, Entry>()
    let phase: 'staging' | 'committed' | 'disposed' = 'staging'
    let validated = false
    if (!profileId || profileId === '*') throw new StudioError('FORBIDDEN', 'Services require a concrete profile')
    for (const declaration of declarations) {
      const token = parseServiceToken(declaration)
      if (pending.has(token.id)) throw new StudioError('REGISTRATION_CONFLICT', 'Duplicate service registration')
      const methods = new Map(Object.entries(token.methods).map(([name, schema]) => [name, { input: compileSchema(schema.input), output: compileSchema(schema.output) }]))
      pending.set(token.id, { token, registration, available, invoke: async (context, method, input, authority) => {
        const contract = methods.get(method)
        if (!contract) throw new StudioError('NOT_FOUND', 'Service method is unavailable')
        const request = jsonCopy(input)
        contract.input(request)
        const result = jsonCopy(await invoke(token.id, context, method, request, authority))
        contract.output(result)
        return result
      } })
    }
    const remove = (id: string) => {
      pending.delete(id)
      const key = this.key(profileId, id)
      if (this.entries.get(key)?.registration === registration) this.entries.delete(key)
    }
    return {
      validate: (actual: ServiceToken[]) => {
        if (phase !== 'staging' || !Array.isArray(actual) || actual.length !== pending.size) throw new StudioError('INVALID_ARGUMENT', 'Plugin must provide every declared service')
        const seen = new Set<string>()
        for (const token of actual) {
          if (seen.has(token.id) || !isDeepStrictEqual(parseServiceToken(token), pending.get(token.id)?.token)) throw new StudioError('INVALID_ARGUMENT', 'Service registration differs from its declaration')
          seen.add(token.id)
        }
        for (const id of pending.keys()) if (this.entries.has(this.key(profileId, id))) throw new StudioError('REGISTRATION_CONFLICT', 'Service is already available')
        validated = true
      },
      commit: () => {
        if (phase !== 'staging' || !validated) throw new StudioError('REGISTRATION_CONFLICT', 'Service registration has not been validated')
        for (const [id, entry] of pending) this.entries.set(this.key(profileId, id), entry)
        phase = 'committed'
      },
      remove,
      dispose: () => { phase = 'disposed'; for (const id of [...pending.keys()]) remove(id) },
    }
  }

  status(profileId: string, dependency: ServiceDependency): { available: boolean; version?: string } {
    const entry = this.entries.get(this.key(profileId, dependency.id))
    return entry?.available() && satisfies(entry.token.version, dependency.version) ? { available: true, version: entry.token.version } : { available: false }
  }

  async call(context: ExecutionContext, dependency: ServiceDependency, method: string, input: JsonValue, authority: ServiceAuthority): Promise<JsonValue> {
    if (context.signal.aborted) throw new StudioError('CANCELLED', 'Service caller scope ended')
    const entry = this.entries.get(this.key(context.scope.profileId, dependency.id))
    if (!entry || !this.status(context.scope.profileId, dependency).available) throw new StudioError('PLUGIN_UNAVAILABLE', 'Service is unavailable')
    return entry.invoke(context, method, input, authority)
  }
  private key(profileId: string, id: string): string { return `${profileId}:${id}` }
}
