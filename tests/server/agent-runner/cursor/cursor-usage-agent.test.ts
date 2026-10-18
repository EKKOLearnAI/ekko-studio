import { describe, expect, it } from 'vitest'
import { usageCodingAgent } from '../../../../packages/server/src/modules/coding-agents/services/runtime/run-manager'

describe('Cursor usage agent id', () => {
  it('records cursor turns as cursor, not claude_code', () => {
    expect(usageCodingAgent('cursor')).toBe('cursor')
    expect(usageCodingAgent('cursor')).not.toBe('claude_code')
    expect(usageCodingAgent('claude-code')).toBe('claude_code')
  })
})
