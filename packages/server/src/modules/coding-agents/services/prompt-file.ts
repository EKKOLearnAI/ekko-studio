import { existsSync, readFileSync, writeFileSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname } from 'path'

export const HERMES_PROMPT_BLOCK_BEGIN = '<!-- BEGIN HERMES WEB UI PROMPT -->'
export const HERMES_PROMPT_BLOCK_END = '<!-- END HERMES WEB UI PROMPT -->'

export function hermesPromptDocument(systemPrompt: string): string {
  return [
    HERMES_PROMPT_BLOCK_BEGIN,
    String(systemPrompt || '').trim(),
    HERMES_PROMPT_BLOCK_END,
    '',
  ].join('\n')
}

export function upsertManagedPromptBlock(existing: string, systemPrompt: string): string {
  const block = hermesPromptDocument(systemPrompt)
  const normalizedBlock = block.endsWith('\n') ? block : `${block}\n`
  const start = existing.indexOf(HERMES_PROMPT_BLOCK_BEGIN)
  const end = existing.indexOf(HERMES_PROMPT_BLOCK_END)
  if (start >= 0 && end >= start) {
    const afterEnd = end + HERMES_PROMPT_BLOCK_END.length
    const before = existing.slice(0, start).replace(/\s*$/, '')
    const after = existing.slice(afterEnd).replace(/^\s*/, '')
    return [before, normalizedBlock.trimEnd(), after].filter(Boolean).join('\n\n') + '\n'
  }
  const trimmedExisting = existing.replace(/\s*$/, '')
  if (!trimmedExisting) return normalizedBlock
  return `${trimmedExisting}\n\n${normalizedBlock}`
}

export async function writeManagedPromptFile(
  path: string,
  systemPrompt: string,
  baseContent?: string,
): Promise<void> {
  let existing = baseContent
  if (existing === undefined) {
    try {
      existing = await readFile(path, 'utf-8')
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err
      existing = ''
    }
  }
  const next = upsertManagedPromptBlock(existing, systemPrompt)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, next, { encoding: 'utf-8', mode: 0o600 })
}

export function updateManagedPromptFileSync(path: string, systemPrompt: string): boolean {
  if (!path || !systemPrompt.trim() || !existsSync(path)) return false
  const existing = readFileSync(path, 'utf-8')
  const next = upsertManagedPromptBlock(existing, systemPrompt)
  if (next === existing) return false
  writeFileSync(path, next, { encoding: 'utf-8', mode: 0o600 })
  return true
}
