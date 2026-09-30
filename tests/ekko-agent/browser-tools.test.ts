import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { writeSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

import { spawn } from 'node:child_process'
import {
  AgentBrowserTool,
  createBrowserTools,
} from '../../packages/ekko-agent/src/index'

const mockedSpawn = vi.mocked(spawn)
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

beforeEach(() => {
  vi.clearAllMocks()
  process.env.AGENT_BROWSER_BIN = '/tmp/agent-browser'
})

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
  delete process.env.AGENT_BROWSER_BIN
  delete process.env.ComSpec
  delete process.env.OPENAI_API_KEY
})

describe('ekko-agent browser tools', () => {
  it('exposes browser tool definitions even before the CLI is available', () => {
    delete process.env.AGENT_BROWSER_BIN

    expect(createBrowserTools().map(tool => tool.definition.name).sort()).toEqual([
      'browser_back',
      'browser_click',
      'browser_console',
      'browser_get_images',
      'browser_navigate',
      'browser_press',
      'browser_scroll',
      'browser_snapshot',
      'browser_type',
      'browser_vision',
    ])
  })

  it('exposes the full Hermes browser tool surface', () => {
    expect(createBrowserTools().map(tool => tool.definition.name).sort()).toEqual([
      'browser_back',
      'browser_click',
      'browser_console',
      'browser_get_images',
      'browser_navigate',
      'browser_press',
      'browser_scroll',
      'browser_snapshot',
      'browser_type',
      'browser_vision',
    ])
  })

  it('runs browser_navigate through agent-browser and auto snapshots the page', async () => {
    mockBrowserSpawn({ success: true, data: { url: 'https://example.com/', title: 'Example' } })
    mockBrowserSpawn({ success: true, data: { snapshot: 'button "Continue" [ref=@e1]', refs: { '@e1': {} } } })

    const tool = createBrowserTools().find(item => item.definition.name === 'browser_navigate')
    const result = await tool?.execute({ url: 'example.com' }, { sessionId: 'session:123', cwd: process.cwd() })

    expect(result).toMatchObject({ ok: true })
    expect(JSON.parse(result?.content || '{}')).toMatchObject({
      success: true,
      url: 'https://example.com/',
      title: 'Example',
      snapshot: 'button "Continue" [ref=@e1]',
      element_count: 1,
    })
    expect(mockedSpawn).toHaveBeenNthCalledWith(
      1,
      '/tmp/agent-browser',
      ['--session', hashedSession('session:123'), '--json', 'open', 'https://example.com'],
      expect.objectContaining({ shell: false }),
    )
    expect(mockedSpawn).toHaveBeenNthCalledWith(
      2,
      '/tmp/agent-browser',
      ['--session', hashedSession('session:123'), '--json', 'snapshot', '-c'],
      expect.objectContaining({ shell: false }),
    )
  })

  it('runs the Windows agent-browser .cmd shim through cmd.exe', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe'
    process.env.AGENT_BROWSER_BIN = 'C:\\Program Files\\Ekko Studio\\agent-browser.cmd'
    mockBrowserSpawn({ success: true, data: { url: 'https://www.baidu.com/', title: 'Baidu' } })
    mockBrowserSpawn({ success: true, data: { snapshot: 'link "News" [ref=@e1]', refs: { '@e1': {} } } })

    const tool = createBrowserTools().find(item => item.definition.name === 'browser_navigate')
    const result = await tool?.execute(
      { url: 'https://www.baidu.com/?from=hermes&mode=agent' },
      { sessionId: 'windows-browser', cwd: 'C:\\workspace' },
    )

    expect(result).toMatchObject({ ok: true })
    expect(mockedSpawn).toHaveBeenCalledTimes(2)
    for (const [command, args, options] of mockedSpawn.mock.calls) {
      expect(command).toBe('C:\\Windows\\System32\\cmd.exe')
      expect(args?.slice(0, 3)).toEqual(['/d', '/s', '/c'])
      expect(args?.[3]).toContain('agent-browser.cmd')
      expect(options).toEqual(expect.objectContaining({
        cwd: 'C:\\workspace',
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: true,
      }))
    }
    expect(mockedSpawn.mock.calls[0]?.[1]?.[3]).toContain('https://www.baidu.com/')
    expect(mockedSpawn.mock.calls[0]?.[1]?.[3]).toContain('^&mode=agent')
  })

  it('passes a sanitized browser environment to the CLI', async () => {
    process.env.OPENAI_API_KEY = 'should-not-leak'
    process.env.BROWSERBASE_API_KEY = 'browser-key'
    mockBrowserSpawn({ success: true, data: { snapshot: 'ok', refs: {} } })

    const tool = createBrowserTools().find(item => item.definition.name === 'browser_snapshot')
    await tool?.execute({}, { browserSessionId: 'browser-session' })

    const options = mockedSpawn.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv }
    expect(options.env?.BROWSERBASE_API_KEY).toBe('browser-key')
    expect(options.env?.OPENAI_API_KEY).toBeUndefined()
    const socketDir = options.env?.AGENT_BROWSER_SOCKET_DIR || ''
    const sessionDir = `eab_${hashedSession('browser-session')}`
    expect(socketDir.endsWith(sessionDir)).toBe(true)
    expect(socketDir.length).toBeLessThan(40)
    if (process.platform !== 'win32') expect(socketDir).toBe(`/tmp/${sessionDir}`)
  })

  it('blocks sensitive console expressions before spawning the browser CLI', async () => {
    const tool = new AgentBrowserTool({
      name: 'browser_console',
      parameters: { type: 'object' },
    })

    const result = await tool.execute({ expression: 'document.cookie' }, { sessionId: 's1' })

    expect(result).toMatchObject({
      ok: false,
      error: 'Blocked: browser_console expression attempts to access sensitive browser or runtime state.',
    })
    expect(mockedSpawn).not.toHaveBeenCalled()
  })

  it('parses image extraction results from browser_get_images', async () => {
    mockBrowserSpawn({
      success: true,
      data: {
        result: JSON.stringify([{ src: 'https://example.com/logo.png', alt: 'Logo', width: 64, height: 64 }]),
      },
    })

    const tool = createBrowserTools().find(item => item.definition.name === 'browser_get_images')
    const result = await tool?.execute({}, { sessionId: 'images' })

    expect(result).toMatchObject({ ok: true })
    expect(JSON.parse(result?.content || '{}')).toMatchObject({
      success: true,
      count: 1,
      images: [{ src: 'https://example.com/logo.png', alt: 'Logo', width: 64, height: 64 }],
    })
    expect(mockedSpawn.mock.calls[0]?.[1]).toEqual([
      '--session',
      hashedSession('images'),
      '--json',
      'eval',
      expect.stringContaining('document.images'),
    ])
  })
})

function hashedSession(value: string): string {
  return `e_${createHash('sha256').update(value).digest('hex').slice(0, 10)}`
}

function mockBrowserSpawn(payload: unknown, exitCode = 0): void {
  mockedSpawn.mockImplementationOnce((_command, _args, options) => {
    const child = new EventEmitter() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>
    }
    child.kill = vi.fn()
    const stdio = Array.isArray(options?.stdio) ? options.stdio : []
    if (typeof stdio[1] === 'number') {
      writeSync(stdio[1], JSON.stringify(payload))
    }
    process.nextTick(() => {
      child.emit('close', exitCode)
    })
    return child as any
  })
}
