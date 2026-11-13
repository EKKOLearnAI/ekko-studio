import { request } from '@/api/client'

export interface StudioAnnouncement {
  id: number
  updateTime: number
  title: string
  content: string
  type: 'info' | 'success' | 'warning' | 'critical'
  dismissible: boolean
  actionUrl: string | null
}

export function fetchStudioAnnouncements(locale: string) {
  const language = /^zh(?:[-_]|$)/i.test(locale) ? 'zh-CN' : 'en'
  return request<{ ok: boolean; platform: 'desktop'; list: StudioAnnouncement[] }>(
    `/api/studio/announcements?locale=${language}`, { cache: 'no-store' },
  )
}
