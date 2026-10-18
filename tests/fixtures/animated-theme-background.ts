import { crc32, deflateSync } from 'node:zlib'
import sharp from 'sharp'

export const animatedThemeFormats = [
  { format: 'gif', mime: 'image/gif', storedMime: 'image/gif', extension: 'gif' },
  { format: 'webp', mime: 'image/webp', storedMime: 'image/webp', extension: 'webp' },
  { format: 'apng', mime: 'image/apng', storedMime: 'image/png', extension: 'png' },
] as const

function pngChunk(type: string, data: Buffer): Buffer {
  const content = Buffer.concat([Buffer.from(type), data])
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length)
  content.copy(chunk, 4)
  chunk.writeUInt32BE(crc32(content), chunk.length - 4)
  return chunk
}

export async function animatedThemeBackground(format: typeof animatedThemeFormats[number]['format']): Promise<Buffer> {
  const width = 16
  const height = 16
  const frames = [[255, 0, 0], [0, 0, 255]].map(color => Buffer.alloc(width * height * 3).fill(Buffer.from(color)))
  if (format !== 'apng') {
    return sharp(Buffer.concat(frames), { raw: { width, height: height * 2, channels: 3, pageHeight: height } })
      .toFormat(format, { loop: 0, delay: [200, 200], lossless: true }).toBuffer()
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const animation = Buffer.alloc(8)
  animation.writeUInt32BE(2)
  const chunks = [pngChunk('IHDR', header), pngChunk('acTL', animation)]
  frames.forEach((frame, index) => {
    const control = Buffer.alloc(26)
    control.writeUInt32BE(index)
    control.writeUInt32BE(width, 4)
    control.writeUInt32BE(height, 8)
    control.writeUInt16BE(1, 20)
    control.writeUInt16BE(5, 22)
    chunks.push(pngChunk('fcTL', control))
    const pixels = Buffer.concat(Array.from({ length: height }, (_, row) =>
      Buffer.concat([Buffer.from([0]), frame.subarray(row * width * 3, (row + 1) * width * 3)])))
    const compressed = deflateSync(pixels)
    const sequence = Buffer.alloc(4)
    sequence.writeUInt32BE(2)
    chunks.push(pngChunk(index === 0 ? 'IDAT' : 'fdAT', index === 0 ? compressed : Buffer.concat([sequence, compressed])))
  })
  chunks.push(pngChunk('IEND', Buffer.alloc(0)))
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks])
}
