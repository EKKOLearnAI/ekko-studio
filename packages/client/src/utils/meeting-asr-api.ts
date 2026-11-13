import { getApiKey, getBaseUrl, getActiveProfileName } from '@/api/client'

const API_BASE = '/api/studio/meeting-asr'

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  const profile = getActiveProfileName()
  if (profile) headers['X-Hermes-Profile'] = profile
  const apiKey = getApiKey()
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }
  return headers
}

export interface MeetingASRStatus {
  isRunning: boolean
  asrPort: number | null
  diarizePort: number | null
  pid: number | null
  uptime: number | null
  error: string | null
  /**
   * Server-side startup lifecycle phase. Kept as `string` here (not a union)
   * so older clients still parse; new UI keys in MeetingView only render
   * known phases and silently fall through to "connecting" otherwise.
   */
  startupPhase?: string
  /** Whether the Python venv has been probed at least once this run. */
  isVenvReady?: boolean
  /**
   * Content hash of the python-backend sources on disk. Compare with the
   * `code_hash` reported by {@link meetingASRApi.healthCheck} to detect a
   * uvicorn child that is still running stale code after a rebuild.
   */
  codeHash?: string | null
}

export interface MeetingASRConfig {
  /**
   * ASR provider: 'dashscope' (default) routes through Paraformer / Fun-ASR
   * WebSocket; 'minimax' routes through the MiniMax Speech-to-Text REST API
   * (https://platform.minimax.cn/docs/api-reference/speech-to-text).
   * Undefined is treated as 'dashscope' for backward compatibility.
   */
  asrProvider?: 'dashscope' | 'minimax'
  dashscopeApiKey?: string
  asrModel?: string  // 'paraformer-v2' | 'fun-asr' | 'fun-asr-mtl' for DashScope
  paraformerWsUrl?: string
  paraformerModel?: string
  paraformerSampleRate?: number
  paraformerFormat?: string
  paraformerLanguageHints?: string
  paraformerSemanticPunctuation?: boolean
  /**
   * MiniMax Speech-to-Text API key (Bearer token for api.minimaxi.com /
   * api.minimax.io). Required only when `asrProvider === 'minimax'`.
   */
  minimaxApiKey?: string
  /** MiniMax ASR model id, e.g. 'asr-1.0'. Defaults to the API default. */
  minimaxAsrModel?: string
  /** MiniMax ASR HTTP base URL, defaults to https://api.minimaxi.com. */
  minimaxBaseUrl?: string
  /**
   * BCP-47 language hint for MiniMax ASR (`zh`, `en`, `yue`, ...). Empty
   * value enables the API's mixed-language auto-detection mode.
   */
  minimaxLanguage?: string
  /**
   * Audio format hint sent to the MiniMax ASR chunk-based flow. MiniMax
   * rejects raw PCM, so the Python layer encodes PCM into WAV before
   * posting. Kept here so operators can override the encoded container
   * (`wav` / `mp3` / `opus` / `aac` / `ogg`) — default `wav`.
   */
  minimaxAudioFormat?: 'wav' | 'mp3' | 'opus' | 'aac' | 'ogg'
  /** Sample rate used when encoding PCM to a container for MiniMax (Hz). */
  minimaxSampleRate?: number
  /**
   * Maximum PCM chunk size fed to MiniMax per request, in seconds. The
   * MiniMax ASR API rejects audio over 500s; the Python chunking layer
   * splits longer recordings into rolling windows of this size.
   */
  minimaxChunkSeconds?: number
  llmApiKey?: string
  llmBaseUrl?: string
  llmModel?: string
  dataDir?: string
  host?: string
  asrPort?: number
  diarizePort?: number
  ossBucket?: string
  ossAccessKeyId?: string
  ossAccessKeySecret?: string
  ossEndpoint?: string
  ossPathPrefix?: string
}

export const meetingASRApi = {
  async getStatus(): Promise<MeetingASRStatus> {
    const response = await fetch(`${getBaseUrl()}${API_BASE}/status`, {
      headers: getAuthHeaders(),
    })
    return response.json()
  },

  async start(config: MeetingASRConfig = {}): Promise<{ status: string } & MeetingASRStatus> {
    const response = await fetch(`${getBaseUrl()}${API_BASE}/start`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(config),
    })
    return response.json()
  },

  async stop(): Promise<{ status: string }> {
    const response = await fetch(`${getBaseUrl()}${API_BASE}/stop`, {
      method: 'POST',
      headers: getAuthHeaders(),
    })
    return response.json()
  },

  async updateConfig(config: Partial<MeetingASRConfig>): Promise<{ status: string; message: string }> {
    const response = await fetch(`${getBaseUrl()}${API_BASE}/config`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(config),
    })
    return response.json()
  },

  async healthCheck(): Promise<{
    status: string
    asr_model: string
    llm_model: string
    /**
     * Whole-file transcription capability marker the backend advertises.
     * The client ships `TRANSCRIBE_CAPABILITY` and restarts the service when
     * the running process reports an older (or missing) value.
     */
    transcribe?: string
    /** Hash of the sources the running process actually imported. */
    code_hash?: string
  }> {
    const response = await fetch(`${getBaseUrl()}${API_BASE}/healthz`, {
      headers: getAuthHeaders(),
    })
    return response.json()
  },

  // Analysis methods
  async startAnalysis(
    intervalSecondsOrConfig: number | { interval_seconds?: number; interval_sentences?: number; trigger_mode?: string; custom_prompt?: string } = 60,
    customPrompt?: string,
  ): Promise<any> {
    const payload = typeof intervalSecondsOrConfig === 'object'
      ? intervalSecondsOrConfig
      : { interval_seconds: intervalSecondsOrConfig, custom_prompt: customPrompt }
    const response = await fetch(`${getBaseUrl()}${API_BASE}/analysis/start`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload),
    })
    return response.json()
  },

  async stopAnalysis(): Promise<any> {
    const response = await fetch(`${getBaseUrl()}${API_BASE}/analysis/stop`, {
      method: 'POST',
      headers: getAuthHeaders(),
    })
    return response.json()
  },

  async triggerAnalysis(): Promise<any> {
    const response = await fetch(`${getBaseUrl()}${API_BASE}/analysis/trigger`, {
      method: 'POST',
      headers: getAuthHeaders(),
    })
    return response.json()
  },

  async getAnalysisStatus(): Promise<any> {
    const response = await fetch(`${getBaseUrl()}${API_BASE}/analysis/status`, {
      headers: getAuthHeaders(),
    })
    return response.json()
  },

  async getAnalysisResult(): Promise<any> {
    const response = await fetch(`${getBaseUrl()}${API_BASE}/analysis/result`, {
      headers: getAuthHeaders(),
    })
    return response.json()
  },

  async getAnalysisHTML(): Promise<string> {
    const response = await fetch(`${getBaseUrl()}${API_BASE}/analysis/html`, {
      headers: getAuthHeaders(),
    })
    return response.text()
  },

  // Note: addTranscript / getTranscript / clearTranscript / getPrompts were
  // removed as dead code (v0.7.6 audit #17). Frontend manages transcript
  // locally via meetingStore; prompts are configured via updateConfig() above.

  /**
   * Whole-file transcription (batch). The audio is POSTed as-is and the
   * backend answers with a job id; poll {@link getFileTranscriptionStatus}
   * until it reaches `done` / `error`.
   *
   * Engines:
   *  - `minimax` — MiniMax `/v1/speech_to_text`, supports diarization
   *    (`response_format=verbose_json`), chunked server-side above 480s.
   *  - `qwen` — Alibaba Cloud Model Studio. Diarization goes through the
   *    async file API (requires OSS); without OSS it falls back to the
   *    synchronous ≤5 min base64 endpoint, which has no speaker labels.
   */
  async startFileTranscription(
    file: Blob,
    options: FileTranscriptionOptions,
  ): Promise<{ job_id: string; status: string }> {
    const params = new URLSearchParams()
    params.set('engine', options.engine)
    params.set('diarize', options.diarize ? 'true' : 'false')
    if (options.speakerCount) params.set('speakerCount', String(options.speakerCount))
    if (options.language) params.set('language', options.language)
    if (options.sessionId) params.set('sessionId', options.sessionId)

    const headers: Record<string, string> = {
      'Content-Type': file.type || 'application/octet-stream',
    }
    const profile = getActiveProfileName()
  if (profile) headers['X-Hermes-Profile'] = profile
  const apiKey = getApiKey()
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

    const response = await fetch(`${getBaseUrl()}${API_BASE}/transcribe/file?${params.toString()}`, {
      method: 'POST',
      headers,
      body: file,
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new MeetingASRHttpError(
        `transcribe start failed: ${response.status}${detail ? ` ${detail.slice(0, 300)}` : ''}`,
        response.status,
        detail,
      )
    }
    return response.json()
  },

  async getFileTranscriptionStatus(jobId: string): Promise<FileTranscriptionJob> {
    const response = await fetch(`${getBaseUrl()}${API_BASE}/transcribe/status/${encodeURIComponent(jobId)}`, {
      headers: getAuthHeaders(),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new MeetingASRHttpError(
        `transcribe status failed: ${response.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`,
        response.status,
        detail,
      )
    }
    return response.json()
  },
}

export type TranscribeEngine = 'minimax' | 'qwen'

/**
 * HTTP failure from a meeting-ASR endpoint. Carries the status so callers can
 * distinguish a *transient* gateway/service failure (502/503 while the Python
 * backend restarts) from a permanent one (404: the in-memory job is gone).
 */
export class MeetingASRHttpError extends Error {
  readonly status: number
  readonly body: string

  constructor(message: string, status: number, body = '') {
    super(message)
    this.name = 'MeetingASRHttpError'
    this.status = status
    this.body = body
  }
}

export interface FileTranscriptionOptions {
  engine: TranscribeEngine
  /** Request speaker labels (`speaker_id` on each sentence). */
  diarize?: boolean
  /** Desired speaker count; 0 / undefined means auto-detect. */
  speakerCount?: number
  /** BCP-47 language hint, e.g. `zh`; empty enables auto detection. */
  language?: string
  /** Stable id used for temp OSS object naming. */
  sessionId?: string
}

export interface FileTranscriptionSentence {
  text: string
  begin_ms: number
  end_ms: number
  /** Global speaker index, or -1 when diarization is off. */
  speaker_id: number
  sentence_id: number
}

export interface FileTranscriptionResult {
  engine: string
  diarize: boolean
  duration_sec: number
  sample_rate: number
  sentences: FileTranscriptionSentence[]
  speakers: number[]
  text: string
  warnings: string[]
}

export interface FileTranscriptionJob {
  job_id: string
  status: 'pending' | 'running' | 'done' | 'error'
  progress: number
  message: string
  engine: string
  diarize: boolean
  error: string | null
  result: FileTranscriptionResult | null
}
