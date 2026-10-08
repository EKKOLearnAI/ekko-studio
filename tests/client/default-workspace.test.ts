// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDefaultWorkspace } from '@/composables/useDefaultWorkspace'

const mocks = vi.hoisted(() => ({
  account: 'account-a', fetch: vi.fn(), record: vi.fn(), favorite: vi.fn(),
}))
vi.mock('@/api/client', () => ({ getApiKey: () => mocks.account, getBaseUrlValue: () => '' }))
vi.mock('@/api/studio/workspace-directories', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/studio/workspace-directories')>(),
  fetchWorkspaceDirectories: mocks.fetch, recordWorkspaceDirectory: mocks.record,
  setWorkspaceDirectoryFavorite: mocks.favorite,
}))
const entry = (path: string, isFavorite = true, lastUsed = 100) => ({
  path, isFavorite, lastUsed, useCount: 1, createdAt: 1, updatedAt: 100,
})

describe('database workspace shortcuts', () => {
  beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); mocks.account = 'account-a' })

  it('loads the account database without reading or migrating legacy caches', async () => {
    localStorage.setItem('hermes:default_workspaces', '["/legacy"]')
    localStorage.setItem('hermes:recent_workspaces', '[{"path":"/legacy","lastUsed":100}]')
    mocks.fetch.mockResolvedValue({ directories: [entry('/saved', true, 200), entry('/recent', false, 300)] })
    const shortcuts = useDefaultWorkspace()
    expect(shortcuts.defaultWorkspaces.value).toEqual([])
    await shortcuts.init()
    expect(shortcuts.defaultWorkspaces.value).toEqual(['/saved'])
    expect(shortcuts.recentWorkspaces.value.map(row => row.path)).toEqual(['/recent', '/saved'])
    expect(shortcuts.getMostRecentDefaultWorkspace()).toBe('/saved')
    expect(mocks.record).not.toHaveBeenCalled()
    expect(mocks.favorite).not.toHaveBeenCalled()
  })

  it('only shows saved changes and keeps history when a favorite is removed', async () => {
    mocks.record.mockResolvedValue({ directories: [entry('/project', false)] })
    mocks.favorite.mockResolvedValueOnce({ directories: [entry('/project')] })
      .mockResolvedValueOnce({ directories: [entry('/project', false)] })
    const shortcuts = useDefaultWorkspace()
    await shortcuts.recordWorkspaceUsage('/project')
    await shortcuts.toggleDefaultWorkspace('/project')
    expect(shortcuts.defaultWorkspaces.value).toEqual(['/project'])
    await shortcuts.toggleDefaultWorkspace('/project')
    expect(shortcuts.defaultWorkspaces.value).toEqual([])
    expect(shortcuts.recentWorkspaces.value).toHaveLength(1)
    expect(mocks.favorite.mock.calls).toEqual([['/project', true], ['/project', false]])
    expect(localStorage.length).toBe(0)
  })

  it('does not mark a failed favorite write as saved', async () => {
    mocks.favorite.mockRejectedValueOnce(new Error('offline'))
    const shortcuts = useDefaultWorkspace()
    await expect(shortcuts.addDefaultWorkspace('/project')).rejects.toThrow('offline')
    expect(shortcuts.defaultWorkspaces.value).toEqual([])
    mocks.fetch.mockResolvedValueOnce({ directories: [entry('/saved')] })
    await shortcuts.init()
    expect(shortcuts.defaultWorkspaces.value).toEqual(['/saved'])
  })

  it('matches Windows favorites across drive case and separator differences', async () => {
    mocks.fetch.mockResolvedValue({ directories: [entry('C:\\Projects\\App')] })
    mocks.favorite.mockResolvedValue({ directories: [entry('C:\\Projects\\App', false)] })
    const shortcuts = useDefaultWorkspace()
    await shortcuts.init()
    expect(shortcuts.isDefaultWorkspace('c:/projects/APP/')).toBe(true)
    await shortcuts.toggleDefaultWorkspace('c:/projects/APP/')
    expect(mocks.favorite).toHaveBeenCalledWith('c:/projects/APP/', false)
  })

  it('discards responses from an account that is no longer active', async () => {
    let finish!: (value: any) => void
    mocks.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const shortcuts = useDefaultWorkspace()
    const oldRequest = shortcuts.init()
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1))
    mocks.account = 'account-b'
    mocks.fetch.mockResolvedValueOnce({ directories: [entry('/b')] })
    const newRequest = shortcuts.init()
    expect(shortcuts.defaultWorkspaces.value).toEqual([])
    finish({ directories: [entry('/a')] })
    await oldRequest
    expect(shortcuts.defaultWorkspaces.value).toEqual([])
    await newRequest
    expect(shortcuts.defaultWorkspaces.value).toEqual(['/b'])
  })
})
