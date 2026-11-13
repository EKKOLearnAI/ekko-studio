import {
  getActiveSttProvider,
  getSttProviderSetting,
} from '../../repositories/stt-settings-store'
import {
  getActiveTtsProvider,
  getTtsProviderSetting,
} from '../../repositories/tts-settings-store'
import { config } from '../../public/config'
import { getToken } from '../../public/auth'
import { updateConfigYamlForProfile } from '../../public/profile-config'
import { logger } from '../../public/logging'
import { safeFileStore } from '../../public/safe-file-store'
import { chmod } from 'fs/promises'
import { join } from 'path'
import { isLocalSttModelUsable } from './stt/local-model-manager'

export type VoiceConfigSyncStatus = 'hermes-studio' | 'fallback' | 'unchanged'
export type VoiceConfigSection = 'stt' | 'tts'

export interface VoiceConfigSyncResult {
  stt: VoiceConfigSyncStatus
  tts: VoiceConfigSyncStatus
}

interface VoiceConfigPatch {
  stt?: Record<string, unknown>
  tts?: Record<string, unknown>
  result: VoiceConfigSyncResult
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {}
}

export function voiceProxyBaseUrl(profile: string): string {
  return `http://127.0.0.1:${config.port}/api/studio/voice/proxy/${encodeURIComponent(profile)}/v1`
}

function quoteCommandArgument(value: string): string {
  if (process.platform === 'win32') {
    return `"${value.replace(/"/g, '""')}"`
  }
  return `'${value.replace(/'/g, `'\\''`)}'`
}

async function ensureCurlConfig(): Promise<string> {
  const path = join(config.appHome, 'runtime', 'hermes-studio-voice.curlrc')
  const token = await getToken()
  await safeFileStore.writeText(path, [
    'silent',
    'show-error',
    'fail',
    `header = "Authorization: Bearer ${token}"`,
    '',
  ].join('\n'))
  try { await chmod(path, 0o600) } catch { /* Windows ignores Unix modes. */ }
  return path
}

function studioTtsCommand(profile: string, curlConfigPath: string): string {
  return [
    'curl',
    '--config', quoteCommandArgument(curlConfigPath),
    '--request', 'POST',
    '--header', quoteCommandArgument('Content-Type: text/plain; charset=utf-8'),
    '--data-binary', '@{input_path}',
    '--output', '{output_path}',
    quoteCommandArgument(`${voiceProxyBaseUrl(profile)}/tts`),
  ].join(' ')
}

function studioSttCommand(profile: string, curlConfigPath: string): string {
  return [
    'curl',
    '--config', quoteCommandArgument(curlConfigPath),
    '--request', 'POST',
    '--form', 'file=@{input_path}',
    '--form', quoteCommandArgument('model=hermes-studio'),
    '--form', quoteCommandArgument('response_format=text'),
    '--output', '{output_path}',
    quoteCommandArgument(`${voiceProxyBaseUrl(profile)}/audio/transcriptions`),
  ].join(' ')
}

function studioProviderConfig(command: string, outputFormat: 'mp3' | 'wav' | 'txt'): Record<string, unknown> {
  return {
    type: 'command',
    command,
    output_format: outputFormat,
    timeout: 120,
    ...(outputFormat !== 'txt' ? { voice_compatible: true } : {}),
  }
}

function buildVoiceConfigPatch(profile: string, curlConfigPath: string, section: VoiceConfigSection): VoiceConfigPatch {
  const patch: VoiceConfigPatch = {
    result: {
      stt: 'unchanged',
      tts: 'unchanged',
    },
  }

  if (section === 'stt') {
    const activeSttProvider = getActiveSttProvider(profile)
    if (activeSttProvider === 'browser') {
      patch.stt = { provider: 'local' }
      patch.result.stt = 'fallback'
    } else if (activeSttProvider === 'local' && isLocalSttModelUsable()) {
      patch.stt = {
        provider: 'hermes-studio',
        providers: {
          'hermes-studio': studioProviderConfig(
            studioSttCommand(profile, curlConfigPath),
            'txt',
          ),
        },
      }
      patch.result.stt = 'hermes-studio'
    } else if (activeSttProvider) {
      const setting = getSttProviderSetting(profile, activeSttProvider, { includeSecrets: true })
      if (!setting?.secrets.apiKey?.trim()) {
        patch.stt = { provider: 'local' }
        patch.result.stt = 'fallback'
      } else {
        patch.stt = {
          provider: 'hermes-studio',
          providers: {
            'hermes-studio': studioProviderConfig(
              studioSttCommand(profile, curlConfigPath),
              'txt',
            ),
          },
        }
        patch.result.stt = 'hermes-studio'
      }
    }
  } else {
    const activeTtsProvider = getActiveTtsProvider(profile)
    if (activeTtsProvider === 'edge') {
      patch.tts = {
        provider: 'hermes-studio',
        providers: {
          'hermes-studio': studioProviderConfig(
            studioTtsCommand(profile, curlConfigPath),
            'mp3',
          ),
        },
      }
      patch.result.tts = 'hermes-studio'
    } else if (activeTtsProvider) {
      const setting = getTtsProviderSetting(profile, activeTtsProvider, { includeSecrets: true })
      if (!setting?.secrets.apiKey?.trim()) {
        patch.tts = { provider: 'edge' }
        patch.result.tts = 'fallback'
      } else {
        const outputFormat = activeTtsProvider === 'gemini' ? 'wav' : 'mp3'
        patch.tts = {
          provider: 'hermes-studio',
          providers: {
            'hermes-studio': studioProviderConfig(
              studioTtsCommand(profile, curlConfigPath),
              outputFormat,
            ),
          },
        }
        patch.result.tts = 'hermes-studio'
      }
    }
  }

  return patch
}

function isStudioCommandProvider(value: unknown, command: string): boolean {
  const provider = asRecord(value)
  // The generated transport remains Studio-owned across server port changes.
  // A different endpoint or command is user-owned, even under the same name.
  const normalizePort = (value: string) => value.replace(
    /http:\/\/127\.0\.0\.1:\d+(\/api\/studio\/voice\/proxy\/)/g,
    'http://127.0.0.1:PORT$1',
  )
  return provider.type === 'command' && typeof provider.command === 'string'
    && normalizePort(provider.command) === normalizePort(command)
}

function mergeVoiceSection(
  currentValue: unknown,
  sectionPatch: Record<string, unknown>,
  command: string,
): Record<string, unknown> {
  const current = asRecord(currentValue)
  const merged = { ...current, ...sectionPatch }

  if (sectionPatch.providers) {
    const currentProviders = asRecord(current.providers)
    const nextProviders = asRecord(sectionPatch.providers)
    if (Object.hasOwn(currentProviders, 'hermes-studio')
      && !isStudioCommandProvider(currentProviders['hermes-studio'], command)) {
      delete nextProviders['hermes-studio']
    }
    merged.providers = {
      ...currentProviders,
      ...nextProviders,
    }
  }
  return merged
}

/**
 * Point Hermes at the profile-scoped Web UI voice proxy. Provider credentials
 * remain exclusively in the Web UI database; Hermes receives a command
 * provider while its loopback token stays in the Web UI-owned curl config.
 * Only explicit selection may replace a native selector; maintenance actions
 * update an existing Studio-owned selection. Custom provider blocks survive both.
 */
export async function syncVoiceConfigToHermesProfile(
  profile: string,
  section: VoiceConfigSection,
  options: { selectProvider?: boolean } = {},
): Promise<VoiceConfigSyncResult> {
  try {
    const curlConfigPath = await ensureCurlConfig()
    const patch = buildVoiceConfigPatch(profile, curlConfigPath, section)
    const sectionPatch = patch[section]
    const command = section === 'stt'
      ? studioSttCommand(profile, curlConfigPath)
      : studioTtsCommand(profile, curlConfigPath)
    if (sectionPatch) {
      await updateConfigYamlForProfile(profile, (configYaml) => {
        const current = asRecord(configYaml[section])
        if (!options.selectProvider && (current.provider !== 'hermes-studio'
          || !isStudioCommandProvider(asRecord(current.providers)['hermes-studio'], command))) {
          patch.result[section] = 'unchanged'
          return { data: configYaml, result: undefined, write: false }
        }
        configYaml[section] = mergeVoiceSection(current, sectionPatch, command)
        return configYaml
      })
    }

    return patch.result
  } catch (error) {
    logger.warn(error, '[voice-config-sync] Failed to configure Web UI voice proxy profile=%s', profile)
    return { stt: 'unchanged', tts: 'unchanged' }
  }
}
