export interface FileEntry {
  name: string
  path: string
  absolutePath?: string
  isDir: boolean
  size: number
  modTime: string
  gitStatus?: GitFileStatus
  gitStatusCount?: number
}

export type GitFileStatus = 'modified' | 'added' | 'untracked' | 'deleted' | 'renamed' | 'conflicted'

export interface FileListResult {
  entries: FileEntry[]
  path: string
  absolutePath?: string
  gitStatus?: GitFileStatus
  gitStatusCount?: number
}

export interface WorkspaceFileDiff {
  path: string
  gitStatus?: GitFileStatus
  patch: string
  additions: number
  deletions: number
  binary: boolean
  truncated: boolean
}
