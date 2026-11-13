import type { TranscribeSpeechRequest } from './stt'

type Expect<T extends true> = T

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
  ? ((<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false)
  : false

type IsRequiredKey<T, K extends keyof T> = {} extends Pick<T, K> ? false : true

export type TranscribeSpeechRequestKeysContract = Expect<
  Equal<keyof TranscribeSpeechRequest, 'audio' | 'provider' | 'language' | 'prompt'>
>

export type TranscribeSpeechRequestAudioRequiredContract = Expect<
  IsRequiredKey<TranscribeSpeechRequest, 'audio'>
>

export type TranscribeSpeechRequestProviderRequiredContract = Expect<
  IsRequiredKey<TranscribeSpeechRequest, 'provider'>
>