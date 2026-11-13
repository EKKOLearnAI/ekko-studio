import { nonDestroyingRequestBody, drainRejectedRequest } from './request-body'

export class MultipartParseError extends Error {}

export function parseMultipartBoundary(contentType: string): Buffer | null {
  const match = contentType.match(/(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/i)
  const boundary = (match?.[1] || match?.[2] || '').trim()
  return boundary ? Buffer.from(`--${boundary}`) : null
}

export function splitMultipart(raw: Buffer, boundary: Buffer): Buffer[] {
  const parts: Buffer[] = []
  let start = 0
  while (true) {
    const idx = raw.indexOf(boundary, start)
    if (idx === -1) break
    if (start > 0) {
      parts.push(raw.subarray(start + 2, idx))
    }
    start = idx + boundary.length
  }
  return parts
}

export function parseMultipartFilename(header: string): string | null {
  const disposition = header.match(/Content-Disposition:\s*form-data;([^\r\n]*)/i)?.[1]
  if (!disposition) return null

  const encodedFilename = disposition.match(/(?:^|;)\s*filename\*\s*=\s*([^;\r\n]+)/i)?.[1]
  if (encodedFilename) {
    const value = encodedFilename.trim().replace(/^"|"$/g, '')
    const utf8Match = value.match(/^UTF-8''(.+)$/i)
    if (!utf8Match) return null

    try {
      return decodeURIComponent(utf8Match[1])
    } catch {
      throw new MultipartParseError('Malformed multipart filename')
    }
  }

  return disposition.match(/(?:^|;)\s*filename="([^"]*)"/i)?.[1] ?? null
}

/** Read one file without buffering the full request or destroying a partially
 * consumed Node request. Header and boundary delimiters may span chunks. */
export async function streamMultipartFirstFile(
  req: AsyncIterable<Buffer>, boundary: Buffer, _targetPath: string,
  writeChunk: (chunk: Buffer) => Promise<void> | void,
): Promise<{ filename: string | null; size: number }> {
  const terminator = Buffer.concat([Buffer.from('\r\n'), boundary])
  let pending = Buffer.alloc(0)
  let filename: string | null = null
  let headersRead = false
  let size = 0
  let complete = false
  for await (const chunk of nonDestroyingRequestBody(req)) {
    pending = Buffer.concat([pending, chunk])
    if (!headersRead) {
      const end = pending.indexOf('\r\n\r\n')
      if (end < 0) {
        if (pending.length > 64 * 1024) throw new MultipartParseError('Multipart headers too large or malformed')
        continue
      }
      if (end > 64 * 1024) throw new MultipartParseError('Multipart headers too large or malformed')
      filename = parseMultipartFilename(pending.subarray(0, end).toString('utf8'))
      if (!filename) throw new MultipartParseError('No file part found in multipart body')
      headersRead = true
      pending = pending.subarray(end + 4)
    }
    const end = pending.indexOf(terminator)
    if (end >= 0) {
      if (end) { await writeChunk(pending.subarray(0, end)); size += end }
      complete = true
      break
    }
    const safe = pending.length - (terminator.length - 1)
    if (safe > 0) {
      await writeChunk(pending.subarray(0, safe))
      size += safe
      pending = pending.subarray(safe)
    }
  }
  if (!complete) throw new MultipartParseError('Incomplete multipart body')
  await drainRejectedRequest(req)
  return { filename, size }
}
