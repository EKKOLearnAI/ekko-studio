import { readFile, readdir, stat } from 'fs/promises'
import { join } from 'path'

export async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}

export async function safeStat(filePath: string): Promise<{ mtime: number } | null> {
  try {
    const result = await stat(filePath)
    return { mtime: Math.round(result.mtimeMs) }
  } catch {
    return null
  }
}

export function extractDescription(content: string): string {
  const lines = content.split('\n')
  let inFrontmatter = false
  let bodyStarted = false
  for (const line of lines) {
    if (!bodyStarted && line.trim() === '---') {
      if (!inFrontmatter) {
        inFrontmatter = true
        continue
      }
      inFrontmatter = false
      bodyStarted = true
      continue
    }
    if (inFrontmatter || line.trim() === '' || line.startsWith('#')) continue
    return line.trim().slice(0, 80)
  }
  return ''
}

export async function listFilesRecursive(dir: string, prefix: string): Promise<Array<{ path: string; name: string }>> {
  const result: Array<{ path: string; name: string }> = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return result
  }
  for (const entry of entries) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) result.push(...await listFilesRecursive(join(dir, entry.name), relPath))
    else result.push({ path: relPath, name: entry.name })
  }
  return result
}
