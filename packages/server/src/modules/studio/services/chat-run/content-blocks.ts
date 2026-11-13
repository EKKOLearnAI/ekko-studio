import type { ContentBlock } from './types'

interface CodingAgentImageInput {
  name: string
  path: string
  mediaType: string
}

type ResponseContentPart = { type: string; text?: string; image_url?: string }
type AgentContentPart = { type: string; text?: string; image_url?: { url: string } }
export interface CodingAgentContent {
  text: string
  images: CodingAgentImageInput[]
}

/**
 * Convert ContentBlock[] to string for display/storage
 */
export function contentBlocksToString(input: string | ContentBlock[]): string {
  if (typeof input === 'string') return input
  return JSON.stringify(input)
}

/**
 * Convert uploaded content blocks into a coding-agent prompt plus native image
 * attachments. File paths remain in the prompt so coding tools can inspect or
 * transform the uploaded files after the initial multimodal turn.
 */
export function convertContentBlocksForCodingAgent(input: string | ContentBlock[]): CodingAgentContent {
  if (typeof input === 'string') return { text: input, images: [] }

  const textParts: string[] = []
  const images: CodingAgentImageInput[] = []
  for (const block of input) {
    if (block.type === 'text') {
      if (block.text.trim()) textParts.push(block.text.trim())
      continue
    }
    if (block.type === 'image') {
      const label = block.video_frame
        ? `Representative frame extracted from the attached video: ${block.name || block.path}`
        : `Attached image: ${block.name || block.path}`
      textParts.push(`[${label}]\nLocal image path for tools: ${block.path}`)
      images.push({
        name: block.name || block.path,
        path: block.path,
        mediaType: block.media_type,
      })
      continue
    }
    textParts.push(`[Attached file: ${block.name || block.path}]\nLocal file path for tools: ${block.path}`)
  }

  return {
    text: textParts.join('\n\n'),
    images,
  }
}

/**
 * Extract text content from ContentBlock[] for title preview
 */
export function extractTextForPreview(input: string | ContentBlock[]): string {
  if (typeof input === 'string') return input
  return input
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/**
 * Check if input is ContentBlock array
 */
export function isContentBlockArray(input: any): input is ContentBlock[] {
  return Array.isArray(input) && input.length > 0 && ('type' in input[0])
}

/**
 * Convert ContentBlock[] to multimodal format for /v1/responses API.
 */
export async function convertContentBlocks(blocks: ContentBlock[]): Promise<ResponseContentPart[]> {
  const parts: ResponseContentPart[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push({ type: 'input_text', text: block.text })
    } else if (block.type === 'image') {
      const dataUri = await imageBlockToDataUri(block)
      if (dataUri) {
        if (block.video_frame) {
          parts.push({
            type: 'input_text',
            text: `[Representative frame extracted from the attached video: ${block.name || block.path}]`,
          })
        }
        parts.push({ type: 'input_image', image_url: dataUri })
      } else {
        parts.push({ type: 'input_text', text: `[Image: ${block.path}]` })
      }
    } else if (block.type === 'file') {
      parts.push({ type: 'input_text', text: `[File: ${block.name || block.path}]` })
    }
  }

  return parts
}

/**
 * Convert ContentBlock[] to the normalized multimodal shape Hermes agent
 * receives after /v1/responses input normalization.
 */
export async function convertContentBlocksForAgent(blocks: ContentBlock[]): Promise<AgentContentPart[]> {
  const parts: AgentContentPart[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text || '' })
    } else if (block.type === 'image') {
      const label = block.video_frame
        ? `Representative frame extracted from the attached video: ${block.name || block.path}`
        : `Attached image: ${block.name || block.path}`
      parts.push({
        type: 'text',
        text: `[${label}]\nLocal image path for tools: ${block.path}`,
      })
      const dataUri = await imageBlockToDataUri(block)
      if (dataUri) {
        parts.push({ type: 'image_url', image_url: { url: dataUri } })
      }
    } else if (block.type === 'file') {
      parts.push({
        type: 'text',
        text: `[Attached file: ${block.name || block.path}]\nLocal file path for tools: ${block.path}`,
      })
    }
  }
  return parts
}

async function imageBlockToDataUri(block: Extract<ContentBlock, { type: 'image' }>): Promise<string | null> {
  try {
    const fs = await import('fs/promises')
    const path = await import('path')
    const buf = await fs.readFile(block.path)
    const ext = path.extname(block.path).toLowerCase().replace('.', '')
    const mimeFromExt = ext === 'jpg' ? 'jpeg' : ext || 'png'
    const mime = block.media_type?.startsWith('image/')
      ? block.media_type.slice('image/'.length)
      : mimeFromExt
    return `data:image/${mime};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}
