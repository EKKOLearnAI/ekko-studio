import { describe, expect, it, vi } from 'vitest'

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  addMessage: vi.fn(),
  clearSessionMessages: vi.fn(),
  createBranchedSession: vi.fn(),
  createSession: vi.fn(),
  getSession: vi.fn(),
  getSessionDetail: vi.fn(),
  renameSession: vi.fn(),
  updateSessionStats: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  readConfigYamlForProfile: vi.fn(async () => ({})),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/compression', () => ({
  buildDbSnapshotAwareHistory: vi.fn(async () => []),
  forceCompressBridgeHistory: vi.fn(),
  getOrCreateSession: vi.fn((map: Map<string, unknown>, id: string) => map.get(id) || { messages: [], isWorking: false }),
  replaceState: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/usage', () => ({
  calcAndUpdateUsage: vi.fn(),
  contextTokensWithCachedOverhead: vi.fn(() => 0),
  estimateUsageTokensFromMessages: vi.fn(() => ({ inputTokens: 0, outputTokens: 0 })),
  updateMessageContextTokenUsage: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/abort', () => ({
  handleAbort: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/bridge-message', () => ({
  flushBridgePendingToDb: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/public/provider-runtime', () => ({
  getModelContextLength: vi.fn(() => 256_000),
}))

const loadParser = async () =>
  import('../../packages/server/src/modules/studio/services/chat-run/session-command')

// CJK IMEs emit full-width punctuation by default. These inputs used to fall
// through to the agent as ordinary user text because the argument separator was
// required to be ASCII whitespace (`\s`).
const CJK_SEPARATORS = [
  ['full-width colon', '/steer：hold off until I confirm'],
  ['ideographic comma', '/steer、hold off until I confirm'],
  ['full-width comma', '/steer，hold off until I confirm'],
  ['half-width comma without space', '/steer,hold off until I confirm'],
] as const

describe('parseSessionCommand argument separators', () => {
  it('keeps accepting ASCII whitespace', async () => {
    const { parseSessionCommand } = await loadParser()
    expect(parseSessionCommand('/steer hold off')).toEqual({
      name: 'steer',
      rawName: 'steer',
      args: 'hold off',
    })
    expect(parseSessionCommand('/steer\nhold off')?.args).toBe('hold off')
    expect(parseSessionCommand('/steer\thold off')?.args).toBe('hold off')
  })

  it('keeps accepting U+3000 ideographic space', async () => {
    // \s already covered U+3000, so this must not regress.
    const { parseSessionCommand } = await loadParser()
    expect(parseSessionCommand('/steer\u3000hold off')?.args).toBe('hold off')
  })

  it.each(CJK_SEPARATORS)('treats a %s as a separator', async (_label, input) => {
    const { parseSessionCommand } = await loadParser()
    expect(parseSessionCommand(input)).toEqual({
      name: 'steer',
      rawName: 'steer',
      args: 'hold off until I confirm',
    })
  })

  it('accepts a CJK argument with no separator at all', async () => {
    // A Latin argument cannot be split without a separator because `\w` would
    // swallow it into the command name (`/steerhold` -> `steerhold`). CJK
    // characters are not `\w`, so the cut point is unambiguous.
    const { parseSessionCommand } = await loadParser()
    expect(parseSessionCommand('/steer先停一下，等我确认')).toEqual({
      name: 'steer',
      rawName: 'steer',
      args: '先停一下，等我确认',
    })
  })

  it('still returns an empty args string when no argument is given', async () => {
    const { parseSessionCommand } = await loadParser()
    expect(parseSessionCommand('/steer')?.args).toBe('')
    expect(parseSessionCommand('/steer ')?.args).toBe('')
  })

  it('does not turn unknown command-like text into a command', async () => {
    const { parseSessionCommand, isSessionCommand } = await loadParser()
    expect(parseSessionCommand('/steerab')).toBeNull()
    expect(parseSessionCommand('/')).toBeNull()
    expect(parseSessionCommand('/1abc')).toBeNull()
    expect(parseSessionCommand('steer hold off')).toBeNull()
    expect(isSessionCommand('/steerab')).toBe(false)
    expect(isSessionCommand('/steer：hold off')).toBe(true)
  })

  it('is case-insensitive on the command name', async () => {
    const { parseSessionCommand } = await loadParser()
    expect(parseSessionCommand('/STEER：hold off')).toEqual({
      name: 'steer',
      rawName: 'steer',
      args: 'hold off',
    })
  })
})

describe('readBridgeSessionCommandName argument separators', () => {
  it.each(CJK_SEPARATORS)('recognises a command separated by a %s', async (_label, input) => {
    const { readBridgeSessionCommandName } = await import(
      '../../packages/client/src/utils/hermes/bridge-session-commands'
    )
    expect(readBridgeSessionCommandName(input)).toBe('steer')
  })

  it('rejects unknown names instead of widening the match', async () => {
    const { readBridgeSessionCommandName } = await import(
      '../../packages/client/src/utils/hermes/bridge-session-commands'
    )
    expect(readBridgeSessionCommandName('/steerab')).toBeNull()
    expect(readBridgeSessionCommandName('/')).toBeNull()
    expect(readBridgeSessionCommandName('steer hold off')).toBeNull()
  })

  it('still recognises commands without arguments', async () => {
    const { readBridgeSessionCommandName } = await import(
      '../../packages/client/src/utils/hermes/bridge-session-commands'
    )
    expect(readBridgeSessionCommandName('/steer')).toBe('steer')
    expect(readBridgeSessionCommandName('/abort')).toBe('abort')
  })
})

describe('command boundary regression', () => {
  it.each([
    ['/title : incident', 'title', ': incident'],
    ['/steer ,keep punctuation', 'steer', ',keep punctuation'],
    ['/plan ：literal', 'plan', '：literal'],
    ['/steer：，keep punctuation', 'steer', '，keep punctuation'],
    ['/steer\n: literal', 'steer', ': literal'],
    ['/steer先停一下', 'steer', '先停一下'],
    ['/steer待って', 'steer', '待って'],
    ['/steer멈춰', 'steer', '멈춰'],
  ])('preserves arguments and client/server agreement: %s', async (input, name, args) => {
    const { parseSessionCommand } = await loadParser()
    const { readBridgeSessionCommandName } = await import('../../packages/client/src/utils/hermes/bridge-session-commands')
    expect(parseSessionCommand(input)).toMatchObject({ name, args })
    expect(readBridgeSessionCommandName(input)).toBe(name)
  })

  it.each(['/clear/cache', '/abort.txt', '/plan?query', '/steer!now', '/steerab', '/steeré'])('rejects non-command boundaries: %s', async input => {
    const { parseSessionCommand } = await loadParser()
    const { readBridgeSessionCommandName } = await import('../../packages/client/src/utils/hermes/bridge-session-commands')
    expect(parseSessionCommand(input)).toBeNull()
    expect(readBridgeSessionCommandName(input)).toBeNull()
  })
})
