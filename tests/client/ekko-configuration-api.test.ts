import { beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ request }))

import {
  deleteEkkoMemory,
  fetchEkkoMemory,
  updateEkkoMemory,
} from '@/api/ekko/memory'
import {
  createEkkoSkill,
  deleteEkkoSkill,
  fetchEkkoExternalDirectories,
  fetchEkkoSkill,
  fetchEkkoSkillFile,
  fetchEkkoSkillFiles,
  fetchEkkoSkills,
  saveEkkoExternalDirectories,
  toggleEkkoSkill,
  updateEkkoSkill,
} from '@/api/ekko/skills'
import {
  createEkkoMcpServer,
  deleteEkkoMcpServer,
  fetchEkkoMcpServers,
  setEkkoMcpServerEnabled,
  testEkkoMcpServer,
  updateEkkoMcpServer,
} from '@/api/ekko/mcp'
import {
  fetchEkkoSettings,
  saveEkkoSettings,
  type EkkoSettingsConfig,
} from '@/api/ekko/config'

beforeEach(() => {
  request.mockReset()
  request.mockResolvedValue({ memories: [], skills: [], servers: [], skill: {}, memory: {}, server: {}, tools: [] })
})

describe('Ekko configuration API', () => {
  it('uses revision-safe memory endpoints and filters', async () => {
    await fetchEkkoMemory({ query: 'dark mode', status: 'active' })
    expect(request).toHaveBeenLastCalledWith('/api/ekko/memory?query=dark+mode&status=active')

    await updateEkkoMemory('memory/1', { expectedRevision: 2, title: 'Theme', content: 'Dark', tags: [] })
    expect(request).toHaveBeenLastCalledWith('/api/ekko/memory/memory%2F1', expect.objectContaining({ method: 'PATCH' }))

    await deleteEkkoMemory('memory/1', 3)
    expect(request).toHaveBeenLastCalledWith('/api/ekko/memory/memory%2F1', {
      method: 'DELETE', body: JSON.stringify({ expectedRevision: 3 }),
    })
  })

  it('uses the Ekko skill collection and item endpoints', async () => {
    await fetchEkkoSkills('release notes')
    await fetchEkkoSkill('release-notes')
    await createEkkoSkill({ name: 'release-notes', content: 'content' })
    await updateEkkoSkill('release-notes', 'updated')
    await deleteEkkoSkill('release-notes')
    await toggleEkkoSkill('release-notes', false)
    await fetchEkkoSkillFiles('release-notes')
    await fetchEkkoSkillFile('release-notes', 'references/checklist.md')
    await fetchEkkoExternalDirectories()
    await saveEkkoExternalDirectories(['~/shared-skills'])

    expect(request.mock.calls.map(call => call[0])).toEqual([
      '/api/ekko/skills?query=release%20notes',
      '/api/ekko/skills/release-notes',
      '/api/ekko/skills',
      '/api/ekko/skills/release-notes',
      '/api/ekko/skills/release-notes',
      '/api/ekko/skills/release-notes/toggle',
      '/api/ekko/skills/release-notes/files',
      '/api/ekko/skills/release-notes/file?path=references%2Fchecklist.md',
      '/api/ekko/skills/external-directories',
      '/api/ekko/skills/external-directories',
    ])
    expect(request).toHaveBeenLastCalledWith('/api/ekko/skills/external-directories', {
      method: 'PUT',
      body: JSON.stringify({ directories: ['~/shared-skills'] }),
    })
  })

  it('uses the Ekko MCP CRUD and test endpoints', async () => {
    const config = { command: 'node', args: ['server.mjs'], enabled: true }
    await fetchEkkoMcpServers()
    await createEkkoMcpServer('local-tools', config)
    await updateEkkoMcpServer('local-tools', config)
    await setEkkoMcpServerEnabled('ekko-studio-api', false)
    await testEkkoMcpServer('local-tools')
    await deleteEkkoMcpServer('local-tools')

    expect(request.mock.calls.map(call => call[0])).toEqual([
      '/api/ekko/mcp/servers',
      '/api/ekko/mcp/servers',
      '/api/ekko/mcp/servers/local-tools',
      '/api/ekko/mcp/servers/ekko-studio-api',
      '/api/ekko/mcp/servers/local-tools/test',
      '/api/ekko/mcp/servers/local-tools',
    ])
    expect(request.mock.calls[3]).toEqual([
      '/api/ekko/mcp/servers/ekko-studio-api',
      { method: 'PATCH', body: JSON.stringify({ enabled: false }) },
    ])
  })

  it('appends the managed-profile query without changing default URLs', async () => {
    const config = { command: 'node', args: ['server.mjs'], enabled: true }
    await fetchEkkoSkills('release notes', 'work')
    await fetchEkkoSkillFile('release-notes', 'references/checklist.md', 'work')
    await toggleEkkoSkill('release-notes', false, 'work')
    await fetchEkkoMcpServers('work')
    await setEkkoMcpServerEnabled('ekko-studio-api', false, 'work')
    await deleteEkkoMcpServer('local-tools', 'work')

    expect(request.mock.calls.map(call => call[0])).toEqual([
      '/api/ekko/skills?query=release%20notes&profile=work',
      '/api/ekko/skills/release-notes/file?path=references%2Fchecklist.md&profile=work',
      '/api/ekko/skills/release-notes/toggle?profile=work',
      '/api/ekko/mcp/servers?profile=work',
      '/api/ekko/mcp/servers/ekko-studio-api?profile=work',
      '/api/ekko/mcp/servers/local-tools?profile=work',
    ])
    expect(request).toHaveBeenLastCalledWith('/api/ekko/mcp/servers/local-tools?profile=work', {
      method: 'DELETE',
    })
  })

  it('loads and replaces the editable Ekko settings through one endpoint', async () => {
    const config = { runtime: { maxSteps: 90 } } as EkkoSettingsConfig
    await fetchEkkoSettings()
    await saveEkkoSettings(config)

    expect(request.mock.calls).toEqual([
      ['/api/ekko/config'],
      ['/api/ekko/config', {
        method: 'PUT',
        body: JSON.stringify({ config }),
      }],
    ])
  })
})
