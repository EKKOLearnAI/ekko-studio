import fs from 'fs/promises'
import path from 'path'
import { existsSync, mkdirSync } from 'fs'
import { logger } from '../../public/logging'
import { getWebUiHome } from '../../public/config'

export interface MeetingData {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  useDiarize: boolean
  sentences: TranscriptSentence[]
  analysisResult: AnalysisResult | null
  htmlContent: string
  speakerMap: Record<string, string>
  speakers: SpeakerEntry[]
  status: 'idle' | 'recording' | 'paused' | 'completed'
  analysisMode: 'hermes' | 'custom'
  hermesProfile?: string
  customProvider?: string
  customModel?: string
  audioDuration: number
}

export interface TranscriptSentence {
  text: string
  timestamp: number
  startTime?: number
  endTime?: number
  speaker?: string
  speakerId?: string
}

export interface AnalysisResult {
  summary?: string
  key_points?: string[]
  action_items?: string[]
  topics?: string[]
  people_mentioned?: string[]
  relationships?: Array<{
    source: string
    target: string
    relation: string
  }>
  timestamp?: number
  html_content?: string
}

export interface SpeakerEntry {
  id: string
  displayName: string
}

export class MeetingStorageService {
  private static instance: MeetingStorageService | null = null
  private baseDir: string

  private constructor() {
    // 与全仓统一: HERMES_WEB_UI_HOME > HERMES_WEBUI_STATE_DIR > ~/.hermes-web-ui
    // 不再回落到 process.cwd() — 那是隐性 BUG 的根源, systemd 下 cwd 是
    // WorkingDirectory (deploy 目录), 会把数据写到不该写的地方。
    const homeDir = getWebUiHome()
    this.baseDir = path.join(homeDir, 'meetings')
    this.ensureBaseDir()
    logger.info('[meeting-storage] baseDir resolved to %s', this.baseDir)
  }

  static getInstance(): MeetingStorageService {
    if (!MeetingStorageService.instance) {
      MeetingStorageService.instance = new MeetingStorageService()
    }
    return MeetingStorageService.instance
  }

  private ensureBaseDir(): void {
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true })
      logger.info('[meeting-storage] Created meetings directory: %s', this.baseDir)
    }
  }

  private getMeetingDir(meetingId: string): string {
    return path.join(this.baseDir, meetingId)
  }

  private ensureMeetingDir(meetingId: string): string {
    const dir = this.getMeetingDir(meetingId)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    return dir
  }

  async saveMeetingMetadata(meetingId: string, data: MeetingData): Promise<void> {
    const dir = this.ensureMeetingDir(meetingId)
    const filePath = path.join(dir, 'metadata.json')
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
    logger.info('[meeting-storage] Saved metadata for meeting: %s', meetingId)
  }

  async getMeetingMetadata(meetingId: string): Promise<MeetingData | null> {
    try {
      const filePath = path.join(this.getMeetingDir(meetingId), 'metadata.json')
      const content = await fs.readFile(filePath, 'utf-8')
      return JSON.parse(content) as MeetingData
    } catch {
      return null
    }
  }

  async saveAudio(meetingId: string, audioBuffer: Buffer): Promise<string> {
    const dir = this.ensureMeetingDir(meetingId)
    const fileName = `recording_${Date.now()}.webm`
    const filePath = path.join(dir, fileName)
    await fs.writeFile(filePath, audioBuffer)
    logger.info('[meeting-storage] Saved audio for meeting %s: %s', meetingId, fileName)
    return filePath
  }

  /**
   * Stream-based variant for large uploads. Caps total bytes written to prevent
   * OOM on the server and to defend against malicious / buggy clients that
   * stream gigabytes without a Content-Length.
   */
  async saveAudioStream(
    meetingId: string,
    source: AsyncIterable<Buffer>,
    maxBytes: number,
  ): Promise<{ path: string; bytes: number }> {
    const dir = this.ensureMeetingDir(meetingId)
    const fileName = `recording_${Date.now()}.webm`
    const filePath = path.join(dir, fileName)
    const fh = await fs.open(filePath, 'w')
    let bytes = 0
    try {
      for await (const chunk of source) {
        bytes += chunk.length
        if (bytes > maxBytes) {
          await fh.close()
          await fs.unlink(filePath).catch(() => {})
          throw new Error(`Audio upload exceeds max size ${maxBytes} bytes`)
        }
        await fh.write(chunk)
      }
    } finally {
      await fh.close().catch(() => {})
    }
    logger.info('[meeting-storage] Saved audio (stream) for meeting %s: %s (%d bytes)', meetingId, fileName, bytes)
    return { path: filePath, bytes }
  }

  async getAudioPath(meetingId: string): Promise<string | null> {
    try {
      const dir = this.getMeetingDir(meetingId)
      const files = await fs.readdir(dir)
      const audioFile = files.find(f => f.startsWith('recording_') && f.endsWith('.webm'))
      return audioFile ? path.join(dir, audioFile) : null
    } catch {
      return null
    }
  }

  async saveTranscript(meetingId: string, sentences: TranscriptSentence[]): Promise<void> {
    const dir = this.ensureMeetingDir(meetingId)
    const filePath = path.join(dir, 'transcript.json')
    await fs.writeFile(filePath, JSON.stringify(sentences, null, 2), 'utf-8')
    logger.info('[meeting-storage] Saved transcript for meeting: %s', meetingId)
  }

  async getTranscript(meetingId: string): Promise<TranscriptSentence[]> {
    try {
      const filePath = path.join(this.getMeetingDir(meetingId), 'transcript.json')
      const content = await fs.readFile(filePath, 'utf-8')
      return JSON.parse(content) as TranscriptSentence[]
    } catch {
      return []
    }
  }

  async saveJsonReport(meetingId: string, data: any): Promise<void> {
    const dir = this.ensureMeetingDir(meetingId)
    const filePath = path.join(dir, 'report.json')
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
    logger.info('[meeting-storage] Saved JSON report for meeting: %s', meetingId)
  }

  async getJsonReport(meetingId: string): Promise<any | null> {
    try {
      const filePath = path.join(this.getMeetingDir(meetingId), 'report.json')
      const content = await fs.readFile(filePath, 'utf-8')
      return JSON.parse(content)
    } catch {
      return null
    }
  }

  async saveHtmlReport(meetingId: string, html: string): Promise<void> {
    const dir = this.ensureMeetingDir(meetingId)
    const filePath = path.join(dir, 'report.html')
    await fs.writeFile(filePath, html, 'utf-8')
    logger.info('[meeting-storage] Saved HTML report for meeting: %s', meetingId)
  }

  async getHtmlReport(meetingId: string): Promise<string | null> {
    try {
      const filePath = path.join(this.getMeetingDir(meetingId), 'report.html')
      return await fs.readFile(filePath, 'utf-8')
    } catch {
      return null
    }
  }

  async deleteMeeting(meetingId: string): Promise<void> {
    try {
      const dir = this.getMeetingDir(meetingId)
      await fs.rm(dir, { recursive: true, force: true })
      logger.info('[meeting-storage] Deleted meeting: %s', meetingId)
    } catch (err) {
      logger.error('[meeting-storage] Failed to delete meeting %s: %s', meetingId, err)
    }
  }

  async listMeetings(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.baseDir, { withFileTypes: true })
      return entries.filter(e => e.isDirectory()).map(e => e.name)
    } catch {
      return []
    }
  }

  async meetingExists(meetingId: string): Promise<boolean> {
    try {
      const dir = this.getMeetingDir(meetingId)
      await fs.access(dir)
      return true
    } catch {
      return false
    }
  }
}

export const meetingStorageService = MeetingStorageService.getInstance()
