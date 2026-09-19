import { describe, expect, it } from 'vitest'
import {
  CURSOR_COMPACT_UNSUPPORTED,
  buildCursorTurnArgs,
} from '../../../../packages/server/src/modules/coding-agents/services/cursor/turn-process'

describe('Cursor stream-json launch args', () => {
  it('locks print-mode flags and a positional prompt', () => {
    const args = buildCursorTurnArgs([], '', false, 'fix the login button')
    expect(args).toEqual([
      '-p',
      '--force',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      'fix the login button',
    ])
    expect(args).toContain('-p')
    expect(args).toContain('--force')
    expect(args).toContain('--output-format')
    expect(args).toContain('stream-json')
    expect(args).toContain('--stream-partial-output')
    expect(args).not.toContain('streaming-json')
    expect(args).not.toContain('--prompt-file')
    expect(args).not.toContain('--session-id')
  })

  it('resumes with --resume and keeps stream-json', () => {
    const args = buildCursorTurnArgs([], 'sess_123', true, 'continue')
    expect(args).toEqual([
      '-p',
      '--force',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      '--resume',
      'sess_123',
      'continue',
    ])
    expect(args).toContain('--resume')
    expect(args).not.toContain('streaming-json')
  })

  it('keeps --approve-mcps from launch baseArgs before the prompt', () => {
    const args = buildCursorTurnArgs(['--approve-mcps'], '', false, 'hi')
    expect(args).toEqual([
      '-p',
      '--force',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      '--approve-mcps',
      'hi',
    ])
    expect(args).not.toContain('--mcp-config')
  })

  it('does not pretend compact is a CLI flag', () => {
    expect(CURSOR_COMPACT_UNSUPPORTED).toBe('Native /compact is not supported for cursor')
    const args = buildCursorTurnArgs([], 'sess_123', true, 'continue')
    expect(args.join(' ')).not.toContain('/compact')
  })
})
