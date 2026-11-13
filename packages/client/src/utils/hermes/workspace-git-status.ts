import type { GitFileStatus } from '@/api/studio/files'

const GIT_STATUS_BADGES: Record<GitFileStatus, string> = {
  modified: 'M',
  added: 'A',
  untracked: 'U',
  deleted: 'D',
  renamed: 'R',
  conflicted: '!',
}

export function gitStatusBadge(status?: GitFileStatus): string {
  return status ? GIT_STATUS_BADGES[status] : ''
}

export function gitStatusClass(status?: GitFileStatus): string | undefined {
  return status ? `git-status-${status}` : undefined
}
