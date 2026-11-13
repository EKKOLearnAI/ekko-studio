import { open, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { AgentToolError, type AgentTool, type AgentToolContext, type AgentToolResult } from './types'
import { resolveToolPath, resolveUnrestrictedToolPath } from './path-safety'
import { ensureDirectory } from './directory'

export const DEFAULT_READ_FILE_MAX_BYTES = 50_000

export interface ReadFileInput extends Record<string, unknown> {
  path: string
  encoding?: BufferEncoding
  offset?: number
  limit?: number
}

export interface WriteFileInput extends Record<string, unknown> {
  path: string
  content: string
  encoding?: BufferEncoding
  createDirs?: boolean
}

export class ReadFileTool implements AgentTool<ReadFileInput> {
  readonly concurrency = 'parallel' as const

  readonly definition = {
    name: 'read_file',
    description: `Read a text file from the local filesystem, reading at most ${DEFAULT_READ_FILE_MAX_BYTES} file bytes per call. Relative paths resolve from the current working directory; absolute paths and paths outside workspaceRoot are supported. Use offset to continue a truncated read.`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path. Relative paths resolve from the current working directory; absolute paths are supported.' },
        encoding: { type: 'string', description: 'Text encoding. Defaults to utf8.' },
        offset: { type: 'number', description: 'Zero-based byte offset. Defaults to 0; use nextOffset from a truncated result to continue.' },
        limit: { type: 'number', description: `Maximum file bytes to read (minimum 4). Defaults to and cannot exceed ${DEFAULT_READ_FILE_MAX_BYTES}.` },
      },
      required: ['path'],
      additionalProperties: false,
    },
  }

  async execute(input: ReadFileInput, context: AgentToolContext = {}): Promise<AgentToolResult> {
    const filePath = resolveUnrestrictedToolPath(input.path, context)
    const encoding = normalizeReadEncoding(input.encoding)
    const offset = nonNegativeInteger(input.offset, 'offset', 0)
    const requestedLimit = positiveInteger(input.limit, 'limit', DEFAULT_READ_FILE_MAX_BYTES, 4)
    const limit = Math.min(requestedLimit, DEFAULT_READ_FILE_MAX_BYTES)
    const file = await open(filePath, 'r')

    try {
      const fileInfo = await file.stat()
      const availableBytes = Math.max(0, fileInfo.size - offset)
      const readCapacity = Math.min(availableBytes, limit)
      const buffer = Buffer.alloc(readCapacity)
      const bytesRead = readCapacity > 0
        ? (await file.read(buffer, 0, readCapacity, offset)).bytesRead
        : 0
      const returnedBytes = decodedByteBoundary(
        buffer.subarray(0, bytesRead),
        encoding,
        offset,
        availableBytes > bytesRead,
      )
      const nextOffset = offset + returnedBytes
      const truncated = nextOffset < fileInfo.size
      const chunk = buffer.subarray(0, returnedBytes).toString(encoding)
      const content = truncated
        ? `${chunk}${chunk && !chunk.endsWith('\n') ? '\n' : ''}\n[read_file truncated: returned bytes ${offset}-${nextOffset - 1} of ${fileInfo.size}; call again with offset=${nextOffset}]`
        : chunk

      return {
        ok: true,
        content,
        data: {
          path: filePath,
          bytes: returnedBytes,
          totalBytes: fileInfo.size,
          offset,
          nextOffset,
          truncated,
          limit,
        },
      }
    } finally {
      await file.close()
    }
  }
}

export class WriteFileTool implements AgentTool<WriteFileInput> {
  readonly definition = {
    name: 'write_file',
    description: 'Write UTF-8 text content to a file in the workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the current workspace.' },
        content: { type: 'string', description: 'Text content to write.' },
        encoding: { type: 'string', description: 'Text encoding. Defaults to utf8.' },
        createDirs: { type: 'boolean', description: 'Create parent directories before writing. Defaults to true.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  }

  async execute(input: WriteFileInput, context: AgentToolContext = {}): Promise<AgentToolResult> {
    const filePath = resolveToolPath(input.path, context)
    if (input.createDirs !== false) {
      // The parent directory of a file at a drive root (`D:\notes.txt`) is the
      // root itself, which mkdir refuses to create on Windows.
      await ensureDirectory(path.dirname(filePath))
    }
    await writeFile(filePath, input.content, input.encoding || 'utf8')
    return {
      ok: true,
      content: `Wrote ${Buffer.byteLength(input.content, input.encoding || 'utf8')} bytes to ${filePath}`,
      data: {
        path: filePath,
        bytes: Buffer.byteLength(input.content, input.encoding || 'utf8'),
      },
    }
  }
}

export function createFileTools(): AgentTool[] {
  return [
    new ReadFileTool(),
    new WriteFileTool(),
  ]
}

function normalizeReadEncoding(value: BufferEncoding | undefined): BufferEncoding {
  const encoding = value || 'utf8'
  if (!Buffer.isEncoding(encoding)) {
    throw new AgentToolError(`Unsupported text encoding: ${encoding}`, 'INVALID_TOOL_INPUT')
  }
  return encoding
}

function nonNegativeInteger(value: number | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AgentToolError(`${name} must be a non-negative integer.`, 'INVALID_TOOL_INPUT')
  }
  return value
}

function positiveInteger(value: number | undefined, name: string, fallback: number, minimum = 1): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new AgentToolError(`${name} must be an integer greater than or equal to ${minimum}.`, 'INVALID_TOOL_INPUT')
  }
  return value
}

function decodedByteBoundary(buffer: Buffer, encoding: BufferEncoding, offset: number, hasMore: boolean): number {
  let end = buffer.length
  if (!hasMore || end === 0) return end
  const normalized = encoding.toLowerCase()
  if (normalized === 'utf8' || normalized === 'utf-8') {
    let lead = end - 1
    while (lead >= 0 && (buffer[lead] & 0xc0) === 0x80) lead -= 1
    if (lead < 0) return end
    const expectedBytes = utf8SequenceBytes(buffer[lead])
    if (expectedBytes > end - lead) end = lead
    return end
  }
  if (
    (normalized === 'utf16le' || normalized === 'utf-16le' || normalized === 'ucs2' || normalized === 'ucs-2')
    && (offset + end) % 2 !== 0
  ) {
    return end - 1
  }
  return end
}

function utf8SequenceBytes(leadByte: number): number {
  if ((leadByte & 0x80) === 0) return 1
  if ((leadByte & 0xe0) === 0xc0) return 2
  if ((leadByte & 0xf0) === 0xe0) return 3
  if ((leadByte & 0xf8) === 0xf0) return 4
  return 1
}
