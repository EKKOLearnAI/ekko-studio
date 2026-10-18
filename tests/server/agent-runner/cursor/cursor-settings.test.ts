import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getCodingAgentConfigFileDefinitions, readCodingAgentConfigFile, writeCodingAgentConfigFile } from '../../../../packages/server/src/modules/coding-agents/services'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'cursor-settings-'))
  vi.stubEnv('HERMES_CODING_AGENT_GLOBAL_HOME', home)
  vi.stubEnv('CURSOR_CONFIG_DIR', '')
  vi.stubEnv('XDG_CONFIG_HOME', '')
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(home, { recursive: true, force: true })
})

describe('Cursor native settings', () => {
  it('offers a valid initial config and saves native fields without changing MCP or credentials', async () => {
    const initial = await readCodingAgentConfigFile('cursor', 'settings')
    expect(initial.absolutePath).toBe(join(home, '.cursor/cli-config.json'))
    expect(initial.exists).toBe(false)
    expect(JSON.parse(initial.content)).toMatchObject({ version: 1, permissions: { allow: [], deny: [] } })
    await expect(readFile(initial.absolutePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await mkdir(join(home, '.cursor'), { recursive: true })
    await writeFile(join(home, '.cursor/mcp.json'), '{"mcpServers":{"native":{}}}')
    await writeFile(join(home, '.cursor/auth.json'), '{"fixture":"preserve"}')
    const content = JSON.stringify({ ...JSON.parse(initial.content), editor: { vimMode: true }, customFutureField: { enabled: true } })
    await writeCodingAgentConfigFile('cursor', 'settings', content)
    expect((await readCodingAgentConfigFile('cursor', 'settings')).content).toBe(content)
    expect(await readFile(initial.absolutePath, 'utf8')).toBe(content)
    expect(await readFile(join(home, '.cursor/mcp.json'), 'utf8')).toBe('{"mcpServers":{"native":{}}}')
    expect(await readFile(join(home, '.cursor/auth.json'), 'utf8')).toBe('{"fixture":"preserve"}')
  })

  it('honors the native config directory overrides in both inventory and read/write', async () => {
    const xdg = join(home, 'xdg')
    vi.stubEnv('XDG_CONFIG_HOME', xdg)
    expect((await readCodingAgentConfigFile('cursor', 'settings')).absolutePath).toBe(join(xdg, 'cursor/cli-config.json'))
    const custom = join(home, 'custom cursor')
    vi.stubEnv('CURSOR_CONFIG_DIR', custom)
    const path = join(custom, 'cli-config.json')
    expect(getCodingAgentConfigFileDefinitions('cursor').find(file => file.key === 'settings')?.absolutePath).toBe(path)
    await writeCodingAgentConfigFile('cursor', 'settings', '{"notifications":true}')
    expect(await readFile(path, 'utf8')).toBe('{"notifications":true}')
    expect((await readCodingAgentConfigFile('cursor', 'settings')).absolutePath).toBe(path)
    await expect(readFile(join(home, '.cursor/cli-config.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['{broken', 'null', '[]', '"value"', ''])('rejects invalid config %j without changing the file', async content => {
    await writeCodingAgentConfigFile('cursor', 'settings', '{"version":1}')
    await expect(writeCodingAgentConfigFile('cursor', 'settings', content)).rejects.toMatchObject({ status: 400 })
    expect((await readCodingAgentConfigFile('cursor', 'settings')).content).toBe('{"version":1}')
  })
})
