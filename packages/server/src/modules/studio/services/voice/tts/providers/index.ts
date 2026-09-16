import { edgeTtsProvider } from './edge'
import { customTtsProvider, deepinfraTtsProvider, openaiTtsProvider, siliconflowTtsProvider, zhipuTtsProvider } from './openai'
import { mimoTtsProvider } from './mimo'
import { doubaoTtsProvider } from './doubao'
import { fishaudioTtsProvider } from './fishaudio'
import { aliyunTtsProvider } from './aliyun'
import { openrouterTtsProvider } from './openrouter'
import {
  elevenLabsTtsProvider,
  geminiTtsProvider,
  minimaxTtsProvider,
  mistralTtsProvider,
  xaiTtsProvider,
} from './hermes-cloud'
import type { TtsProvider, TtsProviderId } from './types'

const providers: Record<TtsProviderId, TtsProvider<any>> = {
  edge: edgeTtsProvider,
  openai: openaiTtsProvider,
  custom: customTtsProvider,
  mimo: mimoTtsProvider,
  doubao: doubaoTtsProvider,
  elevenlabs: elevenLabsTtsProvider,
  gemini: geminiTtsProvider,
  xai: xaiTtsProvider,
  mistral: mistralTtsProvider,
  minimax: minimaxTtsProvider,
  deepinfra: deepinfraTtsProvider,
  siliconflow: siliconflowTtsProvider,
  zhipu: zhipuTtsProvider,
  fishaudio: fishaudioTtsProvider,
  aliyun: aliyunTtsProvider,
  openrouter: openrouterTtsProvider,
}

export function getTtsProvider(provider: string): TtsProvider<any> | undefined {
  return providers[provider as TtsProviderId]
}
