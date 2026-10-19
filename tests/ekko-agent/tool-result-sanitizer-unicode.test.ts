import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sanitizeAgentToolResult } from '../../packages/ekko-agent/src/tools/tool-result-sanitizer'

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
// `JSON.stringify` serializes a lone surrogate as `\ud83d`; strict parsers reject
// that escape, which fails the whole provider request with HTTP 400 (see #3456).
const JSON_LONE_SURROGATE_ESCAPE = /\\u[dD][89abAB][0-9a-fA-F]{2}/
const REPLACEMENT_CHARACTER = /\uFFFD/

let tempRoot: string

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'ekko-sanitizer-unicode-'))
})

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true })
})

function expectSerializable(text: string): void {
  expect(LONE_SURROGATE.test(text)).toBe(false)
  expect(JSON.stringify({ text })).not.toMatch(JSON_LONE_SURROGATE_ESCAPE)
}

describe('sanitizeAgentToolResult unicode boundaries', () => {
  it('does not split a surrogate pair when bounding a large text part', async () => {
    // The last code unit inside the 100_000 cut is the high half of the emoji,
    // so a plain slice(0, 100_000) emits an unpaired surrogate.
    const text = `${'a'.repeat(99_999)}\u{1F600}${'b'.repeat(10)}`
    expect(text.charCodeAt(99_999)).toBeGreaterThanOrEqual(0xd800)
    expect(text.charCodeAt(100_000)).toBeGreaterThanOrEqual(0xdc00)

    const result = await sanitizeAgentToolResult(
      { ok: true, content: 'ok', contentParts: [{ type: 'text', text }] },
      { tempRoot, maxTextBytes: 2_000_000, maxTextArtifactBytes: 2_000_000 },
    )

    const part = result.contentParts?.[0]
    expect(part?.type).toBe('text')
    const projected = part && part.type === 'text' ? part.text : ''
    expect(projected).toHaveLength(99_999)
    expect(projected).toBe('a'.repeat(99_999))
    expectSerializable(projected)
  })

  it('backs the head cut off a multi-byte character instead of emitting U+FFFD', async () => {
    // maxTextBytes 300 with the built-in 2:1 head/tail split puts the head cut at
    // byte 200; the emoji occupies bytes 199-202, so the cut lands inside it.
    const content = `${'x'.repeat(199)}\u{1F600}${'y'.repeat(200)}`
    const result = await sanitizeAgentToolResult(
      { ok: true, content },
      { tempRoot, maxTextBytes: 300, maxTextArtifactBytes: 300 },
    )

    expect(result.content).toContain('[tool result truncated: 403 bytes total')
    expect(result.content.startsWith('x'.repeat(199))).toBe(true)
    expect(result.content).not.toMatch(REPLACEMENT_CHARACTER)
    expectSerializable(result.content)
  })

  it('skips the continuation bytes of a character split by the tail cut', async () => {
    // total = 351 bytes, so the tail cut starts at byte 251, one byte inside the
    // 4-byte emoji that begins at byte 250.
    const content = `${'a'.repeat(250)}\u{1F680}${'y'.repeat(97)}`
    const result = await sanitizeAgentToolResult(
      { ok: true, content },
      { tempRoot, maxTextBytes: 300, maxTextArtifactBytes: 300 },
    )

    expect(result.content).toContain('[tool result truncated: 351 bytes total')
    expect(result.content).not.toMatch(REPLACEMENT_CHARACTER)
    expect(result.content.endsWith('y'.repeat(97))).toBe(true)
    expectSerializable(result.content)
  })

  it('leaves a result under the byte budget untouched', async () => {
    const content = 'plain \u{1F600} text'
    const result = await sanitizeAgentToolResult({ ok: true, content }, { tempRoot })

    expect(result.content).toBe(content)
  })
})
