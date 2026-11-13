import { request } from '../client'
import type { StoredSttProvider } from './stt-settings'

export interface TranscribeSpeechRequest {
  audio: Blob
  provider: StoredSttProvider
  language?: string
  prompt?: string
}

export interface TranscribeSpeechResponse {
  text: string
  provider: StoredSttProvider
  model: string
  language?: string
  durationMs: number
}

export interface LocalSttStreamResponse {
  sessionId: string
  text: string
  model: string
  durationMs: number
}

export async function startLocalSttStream(): Promise<{ sessionId: string }> {
  return request<{ sessionId: string }>('/api/studio/stt/local-stream', {
    method: 'POST',
  })
}

export async function pushLocalSttStreamChunk(sessionId: string, audio: Blob): Promise<LocalSttStreamResponse> {
  return request<LocalSttStreamResponse>(`/api/studio/stt/local-stream/${encodeURIComponent(sessionId)}/chunk`, {
    method: 'POST',
    headers: { 'Content-Type': audio.type || 'audio/wav' },
    body: audio,
  })
}

export async function finishLocalSttStream(sessionId: string): Promise<LocalSttStreamResponse> {
  return request<LocalSttStreamResponse>(`/api/studio/stt/local-stream/${encodeURIComponent(sessionId)}/finish`, {
    method: 'POST',
  })
}

export async function cancelLocalSttStream(sessionId: string): Promise<{ success: true }> {
  return request<{ success: true }>(`/api/studio/stt/local-stream/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  })
}

export async function transcribeSpeech(req: TranscribeSpeechRequest): Promise<TranscribeSpeechResponse> {
  if (!req.provider) {
    throw new Error('STT provider is required')
  }

  const formData = new FormData()
  formData.append('audio', req.audio, speechFileName(req.audio.type))
  formData.append('provider', req.provider)

  if (typeof req.language === 'string' && req.language) {
    formData.append('language', req.language)
  }

  if (typeof req.prompt === 'string' && req.prompt) {
    formData.append('prompt', req.prompt)
  }

  return request<TranscribeSpeechResponse>('/api/studio/stt/transcribe', {
    method: 'POST',
    body: formData,
  })
}

function speechFileName(mimeType: string) {
  const normalized = mimeType.split(';')[0]?.trim().toLowerCase()
  if (normalized === 'audio/wav' || normalized === 'audio/x-wav' || normalized === 'audio/wave') return 'speech.wav'
  if (normalized === 'audio/mpeg' || normalized === 'audio/mp3') return 'speech.mp3'
  if (normalized === 'audio/mp4' || normalized === 'audio/x-m4a') return 'speech.m4a'
  if (normalized === 'audio/ogg') return 'speech.ogg'
  return 'speech.webm'
}
