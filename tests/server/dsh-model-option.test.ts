import { expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { resolveDshModelValue } from '../../packages/server/src/modules/coding-agents/services/dsh/model-option'

// Copied shape from a live DSH ACP session/new response: one model selector
// whose options are grouped per provider.
const choice = (provider: string, model: string) => JSON.stringify([provider, model])
const selector = (current: string, groups: Record<string, string[]>) => [{
  id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: current,
  options: Object.entries(groups).map(([group, models]) => ({
    group, name: group, options: models.map(model => ({ value: choice(group, model), name: model })),
  })),
}]

const native = selector(choice('deepseek-official', 'deepseek-v4-flash'), {
  'deepseek-official': ['deepseek-v4-flash', 'deepseek-v4-pro'],
  'deepseek-account': ['deepseek-v4-flash'],
})

it('resolves a bare global-mode model name to the provider the session advertised', () => {
  expect(resolveDshModelValue(native, 'deepseek-v4-flash')).toBe(choice('deepseek-official', 'deepseek-v4-flash'))
  expect(resolveDshModelValue(native, 'deepseek-v4-pro')).toBe(choice('deepseek-official', 'deepseek-v4-pro'))
})

it('keeps an already valid value byte-identical', () => {
  const value = choice('deepseek-official', 'deepseek-v4-pro')
  expect(resolveDshModelValue(native, value)).toBe(value)
})

it('prefers the session current value when several providers serve the same model', () => {
  const shared = selector(choice('deepseek-account', 'deepseek-v4-flash'), {
    'deepseek-account': ['deepseek-v4-flash'],
    'deepseek-official': ['deepseek-v4-flash'],
  })
  expect(resolveDshModelValue(shared, 'deepseek-v4-flash')).toBe(choice('deepseek-account', 'deepseek-v4-flash'))
  // Without an active choice the name is ambiguous, so the caller keeps what it had.
  expect(resolveDshModelValue(selector('', { 'a': ['same'], 'b': ['same'] }), 'same')).toBe('same')
})

it('passes unknown names and ungrouped selectors through unchanged', () => {
  expect(resolveDshModelValue(native, 'not-installed')).toBe('not-installed')
  expect(resolveDshModelValue(undefined, 'deepseek-v4-flash')).toBe('deepseek-v4-flash')
  expect(resolveDshModelValue([], 'deepseek-v4-flash')).toBe('deepseek-v4-flash')
  const flat = [{ id: 'model', category: 'model', currentValue: '', options: [
    { value: choice('p', 'm'), name: 'm' }, { value: 'opaque-name', name: 'opaque' },
  ] }]
  expect(resolveDshModelValue(flat, 'm')).toBe(choice('p', 'm'))
  expect(resolveDshModelValue(flat, 'opaque-name')).toBe('opaque-name')
})

// A global-mode turn carries the bare model name Studio persisted; the ACP
// request must instead carry the provider/model value DSH advertised.
it('sends the advertised model value for a bare global-mode name', async () => {
  const { DshAcpTurn } = await import('../../packages/server/src/modules/coding-agents/services/dsh/acp-turn')
  const requests: any[] = []
  const child: any = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stdin = Object.assign(new EventEmitter(), {
    writable: true,
    write(line: string) {
      const message = JSON.parse(line)
      requests.push(message)
      const result = message.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: {} }
        : message.method === 'session/prompt' ? { stopReason: 'end_turn' } : { sessionId: 's1', configOptions: native }
      setImmediate(() => child.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n')))
    },
    end: vi.fn(),
  })
  const turn = new DshAcpTurn(child, { update: () => {}, session: () => {}, config: () => {} })
  await turn.prompt({ cwd: '/workspace', text: 'hi', images: [], modelValue: 'deepseek-v4-flash' })
  const sent = requests.find(message => message.method === 'session/set_config_option')
  expect(sent.params).toEqual({ sessionId: 's1', configId: 'model', value: choice('deepseek-official', 'deepseek-v4-flash') })
})
