import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, it, expect, afterEach } from 'vitest'
import iconv from 'iconv-lite'
import {
  chunkDocument,
  detectDocType,
  extractFields,
  parseDocumentFile,
  type ParsedChunk,
} from '../../packages/server/src/modules/studio/services/group-chat/document-parser'

function buildContract(): string {
  const lines: string[] = ['房屋租赁合同', '', '甲方：张三', '乙方：北京某某科技有限公司', '']
  for (let i = 1; i <= 60; i++) {
    lines.push(`第${i}条 甲方应于202${i % 10}年1月${(i % 28) + 1}日向乙方支付人民币${(i * 10000).toLocaleString()}元。`)
    lines.push(`本条款适用《中华人民共和国民法典》第${i}条规定。`)
  }
  return lines.join('\n')
}

function buildJudgment(): string {
  return [
    '民事判决书',
    '案号：（2024）京0105民初12345号',
    '原告：王五',
    '被告：某某商贸有限公司',
    '判决如下：',
    '一、被告于本判决生效之日起十日内支付原告人民币500,000元。',
    '二、驳回原告其他诉讼请求。',
    '本院认为，双方合同关系成立且有效。',
  ].join('\n')
}

const tempDirs: string[] = []

function writeTemp(name: string, content: Buffer | string): string {
  const dir = mkdtempSync(join(tmpdir(), 'gc-parser-test-'))
  tempDirs.push(dir)
  const filePath = join(dir, name)
  writeFileSync(filePath, content)
  return filePath
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

describe('chunkDocument', () => {
  it('splits a long structured document into multiple chunks', () => {
    const text = buildContract()
    const chunks = chunkDocument(text, 200) // budgetInChars = max(2000, 200*4=800) = 2000 < doc length
    expect(chunks.length).toBeGreaterThan(1)
    // Chunks are contiguous and cover the whole text
    let prevEnd = 0
    for (const chunk of chunks) {
      expect(chunk.start_offset).toBe(prevEnd)
      expect(chunk.end_offset).toBeGreaterThan(chunk.start_offset)
      expect(chunk.token_estimate).toBeGreaterThan(0)
      prevEnd = chunk.end_offset
    }
    expect(prevEnd).toBe(text.length)
    // Each chunk has sequential indices
    chunks.forEach((chunk, idx) => expect(chunk.idx).toBe(idx))
  })

  it('falls back to pure token-budget splitting for unstructured text', () => {
    const text = '无结构文本。'.repeat(5000)
    const chunks = chunkDocument(text, 1000)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0].start_offset).toBe(0)
    expect(chunks[chunks.length - 1].end_offset).toBe(text.length)
  })

  it('preserves exact chunk text via offsets', () => {
    const text = buildContract()
    const chunks = chunkDocument(text, 2000)
    for (const chunk of chunks) {
      expect(text.slice(chunk.start_offset, chunk.end_offset).trim()).not.toBe('')
    }
  })
})

describe('detectDocType', () => {
  it('detects contract', () => {
    expect(detectDocType(buildContract())).toBe('contract')
  })
  it('detects judgment', () => {
    expect(detectDocType(buildJudgment())).toBe('judgment')
  })
  it('falls back to generic', () => {
    expect(detectDocType('随便写点什么 no structure here 123')).toBe('generic')
  })
})

describe('extractFields', () => {
  it('extracts amounts, dates, statutes and parties with provenance', () => {
    const text = buildContract()
    const chunks: ParsedChunk[] = [{ chunk_id: 'c0', idx: 0, start_offset: 0, end_offset: text.length, token_estimate: 100 }]
    const fields = extractFields(text, chunks)
    const byType = (t: string) => fields.filter(f => f.field_type === t)

    expect(byType('amount').length).toBeGreaterThanOrEqual(50)
    expect(byType('date').length).toBeGreaterThanOrEqual(50)
    expect(byType('statute').length).toBeGreaterThanOrEqual(50)
    expect(byType('party').length).toBeGreaterThanOrEqual(2)

    // Every field's quote must literally exist at quote_offset in the source text
    for (const field of fields) {
      expect(text.startsWith(field.quote, field.quote_offset)).toBe(true)
    }
  })

  it('deduplicates identical matches and caps the total so dense contracts cannot explode the DB', () => {
    // A dense generated contract repeats the same amount/date/party patterns
    // hundreds of times; extraction must dedupe and stay bounded.
    const line = '甲方：某公司 应于2024年3月1日支付人民币1,000,000元。《民法典》第10条。\n'
    const text = line.repeat(3000)
    const chunks: ParsedChunk[] = [
      { chunk_id: 'c0', idx: 0, start_offset: 0, end_offset: text.length, token_estimate: 100 },
    ]
    const fields = extractFields(text, chunks)

    // 3000 repeats of the same 4 fields — capped far below 12000.
    expect(fields.length).toBeLessThanOrEqual(4000)
    // Repeated identical (type, offset) matches are stored once.
    const keys = new Set(fields.map(f => `${f.field_type}\u0000${f.quote_offset}`))
    expect(keys.size).toBe(fields.length)
  })
})

describe('parseDocumentFile', () => {
  it('parses a UTF-8 Chinese contract end-to-end', () => {
    const filePath = writeTemp('合同.txt', Buffer.from(buildContract(), 'utf-8'))
    const result = parseDocumentFile(filePath, '合同.txt')
    expect(result.encoding).toBe('utf-8')
    expect(result.docType).toBe('contract')
    expect(result.chunks.length).toBeGreaterThan(0)
    expect(result.fields.length).toBeGreaterThan(0)
  })

  it('sniffs GBK encoding and decodes without replacement chars', () => {
    const text = buildContract()
    const filePath = writeTemp('gbk.txt', iconv.encode(text, 'gbk'))
    const result = parseDocumentFile(filePath, 'gbk.txt')
    expect(result.encoding).toBe('gb18030')
    expect(result.text).not.toMatch(/\uFFFD/)
    expect(result.text.slice(0, 20)).toContain('房屋租赁合同')
    expect(result.fields.filter(f => f.field_type === 'amount').length).toBeGreaterThanOrEqual(50)
  })

  it('rejects PDF with a clear error (out of MVP scope)', () => {
    const filePath = writeTemp('a.pdf', Buffer.from('%PDF-1.4 fake'))
    expect(() => parseDocumentFile(filePath, 'a.pdf')).toThrowError(/PDF.*not supported/)
  })

  it('rejects non-docx binary as .docx', () => {
    const filePath = writeTemp('b.docx', Buffer.from('not a zip'))
    expect(() => parseDocumentFile(filePath, 'b.docx')).toThrowError(/docx/)
  })
})
