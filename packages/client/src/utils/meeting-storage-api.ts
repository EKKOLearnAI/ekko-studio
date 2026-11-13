import { getApiKey, getBaseUrl, getActiveProfileName } from '@/api/client'

const API_BASE = '/api/studio/meeting-storage'

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

export interface MeetingData {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  useDiarize: boolean
  sentences: any[]
  analysisResult: any | null
  htmlContent: string
  speakerMap: Record<string, string>
  speakers: any[]
  status: 'idle' | 'recording' | 'paused' | 'completed'
  analysisMode: 'hermes' | 'custom'
  hermesProfile?: string
  customProvider?: string
  customModel?: string
  audioDuration: number
}

export const meetingStorageApi = {
  // Meeting metadata
  async getMeeting(meetingId: string): Promise<MeetingData | null> {
    try {
      const response = await fetch(`${getBaseUrl()}${API_BASE}/${meetingId}`, {
        headers: getAuthHeaders(),
      })
      if (response.status === 404) return null
      return response.json()
    } catch {
      return null
    }
  },

  async saveMeeting(meetingId: string, data: MeetingData): Promise<void> {
    await fetch(`${getBaseUrl()}${API_BASE}/${meetingId}`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify(data),
    })
  },

  async deleteMeeting(meetingId: string): Promise<void> {
    await fetch(`${getBaseUrl()}${API_BASE}/${meetingId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    })
  },

  async listMeetings(): Promise<string[]> {
    const response = await fetch(`${getBaseUrl()}${API_BASE}`, {
      headers: getAuthHeaders(),
    })
    const data = await response.json()
    return data.meetings || []
  },

  /**
   * 仅更新标题（若该会议在服务端已存在），用于 AI 自动命名后的同步。
   * 只对已在服务端落库的会议生效，避免给纯本地会议凭空创建服务端空壳。
   */
  async updateMeetingTitle(meetingId: string, title: string): Promise<void> {
    if (!meetingId || !title) return
    const existing = await this.getMeeting(meetingId)
    if (!existing) return
    await this.saveMeeting(meetingId, {
      ...existing,
      title,
      updatedAt: Date.now(),
    })
  },

  // Audio
  async uploadAudio(meetingId: string, audioBlob: Blob): Promise<void> {
    const headers = getAuthHeaders()
    delete headers['Content-Type'] // Let browser set it with boundary
    
    await fetch(`${getBaseUrl()}${API_BASE}/${meetingId}/audio`, {
      method: 'POST',
      headers,
      body: audioBlob,
    })
  },

  async downloadAudio(meetingId: string): Promise<Blob | null> {
    try {
      const response = await fetch(`${getBaseUrl()}${API_BASE}/${meetingId}/audio`, {
        headers: getAuthHeaders(),
      })
      if (response.status === 404) return null
      return response.blob()
    } catch {
      return null
    }
  },

  // Transcript
  async saveTranscript(meetingId: string, sentences: any[]): Promise<void> {
    await fetch(`${getBaseUrl()}${API_BASE}/${meetingId}/transcript`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify(sentences),
    })
  },

  async getTranscript(meetingId: string): Promise<any[]> {
    try {
      const response = await fetch(`${getBaseUrl()}${API_BASE}/${meetingId}/transcript`, {
        headers: getAuthHeaders(),
      })
      const data = await response.json()
      return data.sentences || []
    } catch {
      return []
    }
  },

  // JSON report
  async saveJsonReport(meetingId: string, data: any): Promise<void> {
    await fetch(`${getBaseUrl()}${API_BASE}/${meetingId}/json`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify(data),
    })
  },

  async downloadJsonReport(meetingId: string): Promise<any | null> {
    try {
      const response = await fetch(`${getBaseUrl()}${API_BASE}/${meetingId}/json`, {
        headers: getAuthHeaders(),
      })
      if (response.status === 404) return null
      return response.json()
    } catch {
      return null
    }
  },

  // HTML report
  async saveHtmlReport(meetingId: string, html: string): Promise<void> {
    await fetch(`${getBaseUrl()}${API_BASE}/${meetingId}/html`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify({ html }),
    })
  },

  async downloadHtmlReport(meetingId: string): Promise<string | null> {
    try {
      const response = await fetch(`${getBaseUrl()}${API_BASE}/${meetingId}/html`, {
        headers: getAuthHeaders(),
      })
      if (response.status === 404) return null
      return response.text()
    } catch {
      return null
    }
  },
}
