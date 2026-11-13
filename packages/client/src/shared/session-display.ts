const SOURCE_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  api_server: 'API Server',
  cli: 'CLI',
  coding_agent: 'Coding Agent',
  builtin_agent: 'Built-in Agent',
  global_agent: 'Global Agent',
  discord: 'Discord',
  slack: 'Slack',
  matrix: 'Matrix',
  whatsapp: 'WhatsApp',
  signal: 'Signal',
  email: 'Email',
  sms: 'SMS',
  dingtalk: 'DingTalk',
  feishu: 'Feishu',
  wecom: 'WeCom',
  weixin: 'WeChat',
  bluebubbles: 'iMessage',
  mattermost: 'Mattermost',
  cron: 'Cron',
}

export function getSourceLabel(source?: string): string {
  if (!source) return ''
  return SOURCE_LABELS[source] || source
}

export function formatTimestampMs(timestamp: number): string {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function formatTimestampSeconds(timestamp: number): string {
  return formatTimestampMs(timestamp * 1000)
}
