import type { FileEntry } from '@/api/studio/files'

export function getClipboardPathForEntry(entry: FileEntry): string {
  return entry.absolutePath || entry.path
}
