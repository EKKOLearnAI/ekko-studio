import { existsSync } from 'fs'
import { stat } from 'fs/promises'
import { resolve } from 'path'
import { config } from '../../../public/config'

export const MCU_TTS_SAMPLE_RATE = 24_000

export type McuPromptId = 'missing-stt' | 'stt-failed' | 'tts-failed' | 'no-device' | 'token-invalid'

interface McuPromptDefinition {
  fileName: string
  text: string
}

export const MCU_PROMPTS: Record<McuPromptId, McuPromptDefinition> = {
  'missing-stt': {
    fileName: 'missing-stt-24k.s16le.pcm',
    text: '当前profile没有配置语音转文字，请配置后再使用哦',
  },
  'stt-failed': {
    fileName: 'stt-failed-24k.s16le.pcm',
    text: '当前语音转文字失败了，请配置下语音转文字再使用哦',
  },
  'tts-failed': {
    fileName: 'tts-failed-24k.s16le.pcm',
    text: '当前文字转语音失败了，请配置下文字转语音再使用哦',
  },
  'no-device': {
    fileName: 'no-device-24k.s16le.pcm',
    text: '你当前没有连接的设备哦，请到网页上连接设备',
  },
  'token-invalid': {
    fileName: 'token-invalid-24k.s16le.pcm',
    text: '当前token验证失败，请重新登录',
  },
}

export function mcuPromptText(id: McuPromptId): string {
  return MCU_PROMPTS[id].text
}

export function mcuPromptFileName(id: McuPromptId): string {
  return MCU_PROMPTS[id].fileName
}

export function mcuPromptUrl(id: McuPromptId): string {
  return `/api/studio/mcu/audio/${mcuPromptFileName(id)}`
}

export function isValidMcuAudioFileName(file: string): boolean {
  return /^[a-f0-9-]+\.(?:pcm|adpcm)$/i.test(file) || Object.values(MCU_PROMPTS).some(prompt => prompt.fileName === file)
}

async function existingFile(path: string): Promise<string | null> {
  try {
    const info = await stat(path)
    return info.isFile() ? path : null
  } catch {
    return null
  }
}

export function bundledMcuPromptAssetPath(file: string): string | null {
  if (!Object.values(MCU_PROMPTS).some(prompt => prompt.fileName === file)) return null

  const candidates = [
    resolve(__dirname, 'assets', 'mcu-prompts', file),
    resolve(__dirname, '..', '..', 'assets', 'mcu-prompts', file),
    resolve(process.cwd(), 'packages/server/src/assets/mcu-prompts', file),
  ]

  return candidates.find(candidate => existsSync(candidate)) || null
}

export async function resolveMcuAudioPath(file: string): Promise<{ path: string; bundled: boolean } | null> {
  const bundledPath = bundledMcuPromptAssetPath(file)
  if (bundledPath) {
    const path = await existingFile(bundledPath)
    if (path) return { path, bundled: true }
  }

  const runtimePath = await existingFile(resolve(config.appHome, 'mcu-audio', file))
  return runtimePath ? { path: runtimePath, bundled: false } : null
}
