import { createHash } from 'node:crypto'
import { SttProviderHttpError, type SttTranscribeInput, type SttTranscribeResult } from './types'
import { transcribeWithProvider } from './index'
import { getLocalSttModelStatus, transcribeWithLocalStt } from './local-model-manager'

interface Dependencies {
  primary(input: SttTranscribeInput): Promise<SttTranscribeResult>
  local(input: SttTranscribeInput): Promise<SttTranscribeResult>
  localReady(): boolean
  now?(): number
}

export function createMcuSttTranscriber(dependencies: Dependencies) {
  const now = dependencies.now || Date.now
  const circuits = new Map<string, { profile: string; sourceProvider: string; reason: string; retryAt: number }>()
  const currentKeys = new Map<string, string>()
  const keyFor = (input: SttTranscribeInput, profile: string) => createHash('sha256')
    .update(JSON.stringify([profile, input.provider, input.settings, input.secrets])).digest('hex')
  const reasonFor = (error: unknown) => {
    if (!(error instanceof SttProviderHttpError)) return ''
    if (error.status === 401 || error.status === 403) return 'provider_authentication'
    if (error.status === 429) return 'provider_quota'
    if (error.status === 408 || error.status >= 500 && error.status <= 599) return 'provider_unavailable'
    return ''
  }
  const local = async (input: SttTranscribeInput) => {
    input.signal?.throwIfAborted()
    const result = await dependencies.local({ ...input, provider: 'local', settings: {}, secrets: {} })
    input.signal?.throwIfAborted()
    return result
  }
  return {
    async transcribe(input: SttTranscribeInput, profile: string): Promise<SttTranscribeResult> {
      input.signal?.throwIfAborted()
      const key = keyFor(input, profile)
      currentKeys.delete(profile)
      currentKeys.set(profile, key)
      while (currentKeys.size > 128) currentKeys.delete(currentKeys.keys().next().value!)
      const before = circuits.get(key)
      if (before && before.retryAt > now() && dependencies.localReady()) return local(input)
      try {
        const result = await dependencies.primary(input)
        input.signal?.throwIfAborted()
        circuits.delete(key)
        return result
      } catch (error) {
        input.signal?.throwIfAborted()
        const reason = reasonFor(error)
        if (input.provider === 'local' || !reason || !dependencies.localReady()) throw error
        // Keep cloud credentials and persisted provider settings unchanged. A new
        // credential/model gets a new key and is tried immediately.
        circuits.delete(key)
        circuits.set(key, { profile, sourceProvider: input.provider, reason, retryAt: now() + 60_000 })
        while (circuits.size > 128) circuits.delete(circuits.keys().next().value!)
        return local(input)
      }
    },
    status(profile: string) {
      const entry = circuits.get(currentKeys.get(profile) || '')
      const current = entry && entry.retryAt > now() ? entry : undefined
      const localAvailable = dependencies.localReady()
      return { localAvailable, active: Boolean(current && localAvailable), sourceProvider: current?.sourceProvider || '', reason: current?.reason || '', retryAt: current?.retryAt || 0 }
    },
  }
}

const transcriber = createMcuSttTranscriber({
  primary: transcribeWithProvider,
  local: transcribeWithLocalStt,
  localReady: () => getLocalSttModelStatus().usable,
})
export const transcribeMcuWithFallback = transcriber.transcribe
export const getMcuSttFallbackStatus = transcriber.status
