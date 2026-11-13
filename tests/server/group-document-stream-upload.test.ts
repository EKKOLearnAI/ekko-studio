import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { parseMultipartBoundary, streamMultipartFirstFile } from '../../packages/server/src/modules/studio/http/multipart'

describe('group document streaming upload', () => {
  it('preserves file bytes when both header and terminating boundary split across chunks', async () => {
    const body = Buffer.from('--abc\r\nContent-Disposition: form-data; name="file"; filename="讨论.txt"\r\nContent-Type: text/plain\r\n\r\nfirst\nsecond\r\n--abc--\r\n')
    const chunks = Array.from(body, byte => Buffer.from([byte]))
    const writes: Buffer[] = []
    const result = await streamMultipartFirstFile(Readable.from(chunks), parseMultipartBoundary('multipart/form-data; boundary=abc')!, '', chunk => { writes.push(chunk) })
    expect(result).toEqual({ filename: '讨论.txt', size: Buffer.byteLength('first\nsecond') })
    expect(Buffer.concat(writes).toString()).toBe('first\nsecond')
  })
  it('rejects a truncated multipart body instead of registering a partial document', async () => {
    const body = Buffer.from('--abc\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\npartial')
    await expect(streamMultipartFirstFile(Readable.from([body]), Buffer.from('--abc'), '', () => {})).rejects.toThrow('Incomplete multipart body')
  })
})
