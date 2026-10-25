import { StudioError } from '../contracts/plugins'
import { parseMultipartBoundary, parseMultipartFilename } from './multipart'
import type { ResourceSkillUpload } from '../services/agents/resource-skill-archive'

/** Binary multipart framing; boundary-like bytes inside files are retained. */
export function parseResourceSkillUpload(contentType: string, raw: Buffer) {
  const boundary = parseMultipartBoundary(contentType)
  if (!/^multipart\/form-data(?:;|$)/i.test(contentType) || !boundary || !/^[\x21-\x7e]{3,202}$/.test(boundary.toString())) throw new StudioError('INVALID_ARGUMENT', 'Expected a bounded multipart Skill upload')
  const opening = Buffer.concat([boundary, Buffer.from('\r\n')]), delimiter = Buffer.concat([Buffer.from('\r\n'), boundary])
  if (!raw.subarray(0, opening.length).equals(opening)) throw new StudioError('INVALID_ARGUMENT', 'Invalid Skill upload framing')
  const fields = new Map<string, string>(), uploads: ResourceSkillUpload[] = []
  let cursor = opening.length, parts = 0
  while (true) {
    if (++parts > 259) throw new StudioError('RESOURCE_EXHAUSTED', 'Skill upload has too many parts')
    const headerEnd = raw.indexOf('\r\n\r\n', cursor)
    if (headerEnd < cursor || headerEnd - cursor > 8192) throw new StudioError('INVALID_ARGUMENT', 'Invalid Skill upload headers')
    let header: string
    try { header = new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(cursor, headerEnd)) }
    catch { throw new StudioError('INVALID_ARGUMENT', 'Invalid Skill upload header encoding') }
    const name = header.match(/Content-Disposition:\s*form-data;[^\r\n]*?\bname="([^"]+)"/i)?.[1]
    const bodyStart = headerEnd + 4
    let end = raw.indexOf(delimiter, bodyStart)
    while (end >= 0) {
      const tail = raw.subarray(end + delimiter.length, end + delimiter.length + 2).toString()
      if (tail === '--' || tail === '\r\n') break
      end = raw.indexOf(delimiter, end + 1)
    }
    if (end < 0) throw new StudioError('INVALID_ARGUMENT', 'Truncated Skill upload')
    let filename: string | null
    try { filename = parseMultipartFilename(header) }
    catch { throw new StudioError('INVALID_ARGUMENT', 'Invalid Skill upload filename') }
    const data = raw.subarray(bodyStart, end)
    if (name === 'file' && filename !== null) uploads.push({ filename, data })
    else {
      if (!name || !['revision', 'snapshot', 'locationId'].includes(name) || filename !== null || fields.has(name) || data.length > 4096) throw new StudioError('INVALID_ARGUMENT', 'Unexpected Skill upload field')
      fields.set(name, data.toString('utf8'))
    }
    cursor = end + delimiter.length
    if (raw.subarray(cursor, cursor + 2).toString() === '--') {
      const suffix = raw.subarray(cursor + 2).toString()
      if (suffix !== '' && suffix !== '\r\n') throw new StudioError('INVALID_ARGUMENT', 'Unexpected Skill upload trailer')
      break
    }
    cursor += 2
  }
  const revisionText = fields.get('revision') || '', revision = Number(revisionText), snapshot = fields.get('snapshot'), locationId = fields.get('locationId')
  if (!/^[1-9][0-9]*$/.test(revisionText) || !Number.isSafeInteger(revision) || !snapshot || !/^[a-f0-9]{64}$/.test(snapshot)
    || !locationId || locationId.length > 128 || !uploads.length) throw new StudioError('INVALID_ARGUMENT', 'Skill upload requires the current revision, source and snapshot')
  return { revision, snapshot, locationId, uploads }
}
