import { StudioError } from './errors'
import type { AgentRunContext, ContentBlock } from './types'

/** Consume bounded host chunks without sending image bytes in Run/RPC input DTOs. */
export async function readAgentImages(content: ContentBlock[], ctx: Pick<AgentRunContext, 'signal' | 'artifacts'>) {
  const images = new Map<string, { data: string; mediaType: string }>()
  let total = 0, count = 0
  for (const block of content) {
    if (block.type === 'file') throw new StudioError('CAPABILITY_UNSUPPORTED', 'File input is unavailable')
    if (block.type !== 'image') continue
    if (++count > 8) throw new StudioError('RESOURCE_EXHAUSTED', 'Too many images')
    const parts: string[] = []
    let offset = 0, length: number | undefined
    do {
      if (ctx.signal.aborted) throw new StudioError('CANCELLED', 'Image read cancelled')
      const chunk = await ctx.artifacts.read(block.artifactId, offset)
      if (ctx.signal.aborted) throw new StudioError('CANCELLED', 'Image read cancelled')
      if (chunk.id !== block.artifactId || chunk.mediaType !== block.mediaType || chunk.offset !== offset
        || !Number.isSafeInteger(chunk.byteLength) || chunk.byteLength < 1 || chunk.byteLength > 4 * 1024 * 1024
        || (length !== undefined && length !== chunk.byteLength) || typeof chunk.data !== 'string' || chunk.data.length > 262144) {
        throw new StudioError('INVALID_ARGUMENT', 'Invalid image chunk')
      }
      let bytes: string
      try { bytes = atob(chunk.data) } catch { throw new StudioError('INVALID_ARGUMENT', 'Invalid image encoding') }
      if (!bytes.length || btoa(bytes) !== chunk.data || chunk.nextOffset !== offset + bytes.length
        || chunk.nextOffset > chunk.byteLength || chunk.done !== (chunk.nextOffset === chunk.byteLength)) throw new StudioError('INVALID_ARGUMENT', 'Invalid image chunk progress')
      total += bytes.length
      if (total > 6 * 1024 * 1024) throw new StudioError('RESOURCE_EXHAUSTED', 'Run images exceed 6 MiB')
      parts.push(bytes); offset = chunk.nextOffset; length = chunk.byteLength
    } while (offset < length)
    images.set(block.artifactId, { data: btoa(parts.join('')), mediaType: block.mediaType })
  }
  return images
}
