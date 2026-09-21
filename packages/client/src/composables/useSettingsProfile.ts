import { hasInjectionContext, inject, reactive, type InjectionKey, type Ref } from 'vue'
import { request } from '@/api/client'

type ProfileRequest = typeof request

export interface SettingsProfileScope {
  profile: string
  request: typeof request
  voiceClone: { dataUri: string; fileName: string; format: 'mp3' | 'wav' }
}

export const SETTINGS_PROFILE_SCOPE: InjectionKey<Ref<SettingsProfileScope | null>> = Symbol('settings-profile')

export function createSettingsProfileScope(profile: string): SettingsProfileScope {
  if (!profile.trim()) throw new Error('A settings Profile is required')
  return {
    profile,
    voiceClone: reactive({ dataUri: '', fileName: '', format: 'wav' as const }),
    request: (path, options = {}) => {
      // Capture a fixed Profile so even delayed saves keep their original target.
      const headers = new Headers(options.headers)
      headers.set('X-Hermes-Profile', profile)
      return request(path, { ...options, headers: Object.fromEntries(headers.entries()) })
    },
  }
}

export function useSettingsProfileScope(): SettingsProfileScope | null {
  return hasInjectionContext() ? inject(SETTINGS_PROFILE_SCOPE, null)?.value ?? null : null
}

export function useSettingsApi<T>(api: T & { createApi: (scopedRequest: ProfileRequest) => T }): T {
  const scope = useSettingsProfileScope()
  return scope ? api.createApi(scope.request) : api
}
