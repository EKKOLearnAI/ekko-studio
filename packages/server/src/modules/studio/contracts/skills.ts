export type SkillSource = 'builtin' | 'hub' | 'local' | 'external'

export interface SkillUsageRow {
  skill: string
  view_count: number
  manage_count: number
  total_count: number
  percentage: number
  last_used_at: number | null
}

export interface SkillUsageDailySkillRow {
  skill: string
  view_count: number
  manage_count: number
  total_count: number
}

export interface SkillUsageDailyRow {
  date: string
  view_count: number
  manage_count: number
  total_count: number
  skills: SkillUsageDailySkillRow[]
}

export interface SkillUsageStats {
  period_days: number
  summary: {
    total_skill_loads: number
    total_skill_edits: number
    total_skill_actions: number
    distinct_skills_used: number
  }
  by_day: SkillUsageDailyRow[]
  top_skills: SkillUsageRow[]
}

export interface LocalSkillUsageStatsResult {
  stats: SkillUsageStats
  sessionIds: string[]
}

export interface ExternalSkillUsageEvent {
  messageId: number
  sessionId: string
  runId?: string
  skill: string
  action: 'view' | 'manage'
  timestamp: number
}
