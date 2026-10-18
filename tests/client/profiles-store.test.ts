// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

const mockProfilesApi = vi.hoisted(() => ({
  fetchProfiles: vi.fn(),
  fetchProfileDetail: vi.fn(),
  createProfile: vi.fn(),
  deleteProfile: vi.fn(),
  renameProfile: vi.fn(),
  switchProfile: vi.fn(),
  exportProfile: vi.fn(),
  importProfile: vi.fn(),
  updateProfileAvatar: vi.fn(),
  deleteProfileAvatar: vi.fn(),
}))

const mockAgentStatusApi = vi.hoisted(() => ({
  fetchAgentStatusSnapshot: vi.fn(),
}))

vi.mock('@/api/hermes/profiles', () => mockProfilesApi)
vi.mock('@/api/agent-status', () => mockAgentStatusApi)

import { useProfilesStore } from '@/stores/hermes/profiles'

describe('Profiles Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mockAgentStatusApi.fetchAgentStatusSnapshot.mockResolvedValue({
      revision: 1,
      updatedAt: new Date(0).toISOString(),
      agents: [{
        id: 'hermes',
        installed: false,
        source: 'not-installed',
        path: '',
        version: '',
      }],
    })
  })

  it('tracks Hermes availability from the server Agent status snapshot', async () => {
    mockProfilesApi.fetchProfiles.mockResolvedValue([
      { name: 'default', active: true, model: 'gpt-4', alias: '' },
    ])
    mockAgentStatusApi.fetchAgentStatusSnapshot.mockResolvedValue({
      revision: 2,
      updatedAt: new Date().toISOString(),
      agents: [{
        id: 'hermes',
        installed: true,
        source: 'user-cli',
        path: '/usr/local/bin/hermes',
        version: '0.20.4',
      }],
    })

    const store = useProfilesStore()
    await store.fetchHermesProfiles()

    expect(store.hermesAvailable).toBe(true)
  })

  it('keeps profiles usable but hides Hermes-only actions when Agent status fails', async () => {
    mockProfilesApi.fetchProfiles.mockResolvedValue([
      { name: 'default', active: true, model: 'gpt-4', alias: '' },
    ])
    mockAgentStatusApi.fetchAgentStatusSnapshot.mockRejectedValue(new Error('status unavailable'))

    const store = useProfilesStore()
    await store.fetchHermesProfiles()

    expect(store.profiles).toHaveLength(1)
    expect(store.hermesAvailable).toBe(false)
  })

  it('fetchProfiles loads profiles and sets active', async () => {
    const profiles = [
      { name: 'default', active: true, model: 'gpt-4', alias: '' },
      { name: 'dev', active: false, model: 'gpt-4', alias: '' },
    ]
    mockProfilesApi.fetchProfiles.mockResolvedValue(profiles)

    const store = useProfilesStore()
    await store.fetchProfiles()

    expect(store.profiles).toEqual(profiles)
    expect(store.activeProfile?.name).toBe('default')
    expect(store.loading).toBe(false)
  })

  it('fetchProfiles sets loading state', async () => {
    mockProfilesApi.fetchProfiles.mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve([]), 10))
    )

    const store = useProfilesStore()
    const fetchPromise = store.fetchProfiles()

    expect(store.loading).toBe(true)
    await fetchPromise
    expect(store.loading).toBe(false)
  })

  it('shares concurrent page/selector loads but refreshes on later visits', async () => {
    const profiles = [{ name: 'default', active: true, model: 'test-model', alias: '' }]
    let resolve!: (value: typeof profiles) => void
    mockProfilesApi.fetchProfiles.mockReturnValueOnce(new Promise(done => { resolve = done }))
    const store = useProfilesStore()

    const pageLoad = store.fetchProfiles()
    const selectorLoad = store.fetchProfiles()

    expect(mockProfilesApi.fetchProfiles).toHaveBeenCalledTimes(1)
    expect(store.loading).toBe(true)
    resolve(profiles)
    await Promise.all([pageLoad, selectorLoad])
    expect(store.profiles).toEqual(profiles)
    expect(store.loading).toBe(false)

    mockProfilesApi.fetchProfiles.mockResolvedValueOnce([])
    await store.fetchProfiles()
    expect(mockProfilesApi.fetchProfiles).toHaveBeenCalledTimes(2)
    expect(store.profiles).toEqual([])
  })

  it('can retry after a shared profile request fails', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockProfilesApi.fetchProfiles.mockRejectedValueOnce(new Error('temporarily unavailable'))
    const store = useProfilesStore()
    await Promise.all([store.fetchProfiles(), store.fetchProfiles()])
    expect(mockProfilesApi.fetchProfiles).toHaveBeenCalledTimes(1)
    expect(store.loading).toBe(false)

    mockProfilesApi.fetchProfiles.mockResolvedValueOnce([{ name: 'default', active: true, model: 'test-model', alias: '' }])
    await store.fetchProfiles()
    expect(store.profiles).toHaveLength(1)
    expect(mockProfilesApi.fetchProfiles).toHaveBeenCalledTimes(2)
    errorLog.mockRestore()
  })

  it('refreshes after a mutation even when an older list is still pending', async () => {
    let resolve!: (value: unknown[]) => void
    mockProfilesApi.fetchProfiles.mockReturnValueOnce(new Promise(done => { resolve = done }))
    mockProfilesApi.createProfile.mockResolvedValueOnce({ success: true })
    const store = useProfilesStore()
    const initialLoad = store.fetchProfiles()
    const mutation = store.createProfile('new-profile')
    await Promise.resolve()
    expect(mockProfilesApi.fetchProfiles).toHaveBeenCalledTimes(1)

    mockProfilesApi.fetchProfiles.mockResolvedValueOnce([
      { name: 'default', active: true, model: '', alias: '' },
      { name: 'new-profile', active: false, model: '', alias: '' },
    ])
    resolve([])
    await Promise.all([initialLoad, mutation])

    expect(mockProfilesApi.fetchProfiles).toHaveBeenCalledTimes(2)
    expect(store.profiles.map(profile => profile.name)).toEqual(['default', 'new-profile'])
  })

  it('createProfile calls API and refreshes list', async () => {
    mockProfilesApi.createProfile.mockResolvedValue({ success: true })
    mockProfilesApi.fetchProfiles.mockResolvedValue([
      { name: 'default', active: true, model: 'gpt-4', alias: '' },
      { name: 'new-profile', active: false, model: 'gpt-4', alias: '' },
    ])

    const store = useProfilesStore()
    const result = await store.createProfile('new-profile', false)

    expect(result.success).toBe(true)
    expect(mockProfilesApi.createProfile).toHaveBeenCalledWith('new-profile', false)
    expect(store.profiles).toHaveLength(2)
  })

  it('refreshes profiles only after a successful import', async () => {
    mockProfilesApi.importProfile.mockResolvedValue({ success: false, error: 'invalid archive' })
    mockProfilesApi.fetchProfiles.mockResolvedValue([])
    const store = useProfilesStore()
    const file = new File(['archive'], 'profile.tar.gz')

    const failed = await store.importProfile(file)

    expect(failed).toEqual({ success: false, error: 'invalid archive' })
    expect(mockProfilesApi.fetchProfiles).not.toHaveBeenCalled()

    mockProfilesApi.importProfile.mockResolvedValue({ success: true })
    const succeeded = await store.importProfile(file)

    expect(succeeded).toEqual({ success: true })
    expect(mockProfilesApi.fetchProfiles).toHaveBeenCalledTimes(1)
  })

  it('deleteProfile clears detail cache', async () => {
    mockProfilesApi.deleteProfile.mockResolvedValue(true)
    mockProfilesApi.fetchProfiles.mockResolvedValue([
      { name: 'default', active: true, model: 'gpt-4', alias: '' },
    ])

    const store = useProfilesStore()
    store.detailMap['test'] = { name: 'test', path: '/tmp/test', model: '', provider: '', skills: 0, hasEnv: false, hasSoulMd: false }

    await store.deleteProfile('test')

    expect(store.detailMap['test']).toBeUndefined()
    expect(mockProfilesApi.deleteProfile).toHaveBeenCalledWith('test')
  })

  it('fetchProfileDetail uses cache', async () => {
    const detail = { name: 'cached', path: '/tmp/cached', model: 'gpt-4', provider: 'openai', skills: 5, hasEnv: true, hasSoulMd: false }
    const store = useProfilesStore()
    store.detailMap['cached'] = detail

    const result = await store.fetchProfileDetail('cached')

    expect(result).toEqual(detail)
    expect(mockProfilesApi.fetchProfileDetail).not.toHaveBeenCalled()
  })

  it('updateAvatar updates profile, detail cache, and active profile', async () => {
    const savedAvatar = { type: 'image', dataUrl: 'data:image/png;base64,YQ==' }
    mockProfilesApi.updateProfileAvatar.mockResolvedValue(savedAvatar)

    const store = useProfilesStore()
    store.profiles = [
      { name: 'default', active: true, model: 'gpt-4', alias: '' },
      { name: 'dev', active: false, model: 'gpt-4', alias: '' },
    ]
    store.activeProfile = store.profiles[0]
    store.detailMap.default = { name: 'default', path: '/tmp/default', model: '', provider: '', skills: 0, hasEnv: false, hasSoulMd: false }

    const result = await store.updateAvatar('default', { type: 'image', dataUrl: savedAvatar.dataUrl })

    expect(result).toEqual(savedAvatar)
    expect(mockProfilesApi.updateProfileAvatar).toHaveBeenCalledWith('default', { type: 'image', dataUrl: savedAvatar.dataUrl })
    expect(store.profiles[0].avatar).toEqual(savedAvatar)
    expect(store.activeProfile?.avatar).toEqual(savedAvatar)
    expect(store.detailMap.default.avatar).toEqual(savedAvatar)
  })

  it('deleteAvatar clears avatar state', async () => {
    mockProfilesApi.deleteProfileAvatar.mockResolvedValue(undefined)

    const store = useProfilesStore()
    store.profiles = [
      { name: 'default', active: true, model: 'gpt-4', alias: '', avatar: { type: 'generated', seed: 'old' } },
    ]
    store.activeProfile = store.profiles[0]
    store.detailMap.default = {
      name: 'default',
      path: '/tmp/default',
      model: '',
      provider: '',
      skills: 0,
      hasEnv: false,
      hasSoulMd: false,
      avatar: { type: 'generated', seed: 'old' },
    }

    await store.deleteAvatar('default')

    expect(mockProfilesApi.deleteProfileAvatar).toHaveBeenCalledWith('default')
    expect(store.profiles[0].avatar).toBeNull()
    expect(store.activeProfile?.avatar).toBeNull()
    expect(store.detailMap.default.avatar).toBeNull()
  })

  it('switchProfile sets switching state', async () => {
    mockProfilesApi.switchProfile.mockResolvedValue(true)
    mockProfilesApi.fetchProfiles.mockResolvedValue([])

    const store = useProfilesStore()
    const switchPromise = store.switchProfile('dev')

    expect(store.switching).toBe(true)
    await switchPromise
    expect(store.switching).toBe(false)
  })

  it('switchProfile updates activeProfileName immediately', async () => {
    mockProfilesApi.switchProfile.mockResolvedValue(true)
    mockProfilesApi.fetchProfiles.mockResolvedValue([
      { name: 'default', active: false, model: 'gpt-4', alias: '' },
      { name: 'dev', active: true, model: 'gpt-4', alias: '' },
    ])

    const store = useProfilesStore()
    await store.switchProfile('dev')

    // activeProfileName should be updated immediately
    expect(store.activeProfileName).toBe('dev')
    // localStorage should also be updated
    expect(localStorage.getItem('hermes_active_profile_name')).toBe('dev')
  })

  it('switchProfile does not update state when API fails', async () => {
    const initialName = 'default'
    localStorage.setItem('hermes_active_profile_name', initialName)

    mockProfilesApi.switchProfile.mockResolvedValue(false)  // API failed

    const store = useProfilesStore()
    store.activeProfileName = initialName
    const result = await store.switchProfile('dev')

    // Should return false
    expect(result).toBe(false)
    // activeProfileName should NOT change
    expect(store.activeProfileName).toBe(initialName)
    // localStorage should NOT change
    expect(localStorage.getItem('hermes_active_profile_name')).toBe(initialName)
  })

  it('switchProfile keeps activeProfileName even if fetchProfiles fails', async () => {
    const initialName = 'default'
    localStorage.setItem('hermes_active_profile_name', initialName)

    mockProfilesApi.switchProfile.mockResolvedValue(true)
    mockProfilesApi.fetchProfiles.mockRejectedValue(new Error('Network error'))

    const store = useProfilesStore()
    store.activeProfileName = initialName
    const result = await store.switchProfile('dev')

    // Should return true (API succeeded)
    expect(result).toBe(true)
    // activeProfileName should be updated even though fetchProfiles failed
    expect(store.activeProfileName).toBe('dev')
    // localStorage should be updated
    expect(localStorage.getItem('hermes_active_profile_name')).toBe('dev')
  })

  it('switchProfile keeps the local selected profile independent of backend active flags', async () => {
    const initialName = 'default'
    localStorage.setItem('hermes_active_profile_name', initialName)

    mockProfilesApi.switchProfile.mockResolvedValue(true)
    mockProfilesApi.fetchProfiles.mockResolvedValue([
      { name: 'default', active: true, model: 'gpt-4', alias: '' },
      { name: 'dev', active: false, model: 'gpt-4', alias: '' },
    ])

    const store = useProfilesStore()
    store.activeProfileName = initialName
    const result = await store.switchProfile('dev')

    expect(result).toBe(true)
    expect(store.activeProfileName).toBe('dev')
    expect(localStorage.getItem('hermes_active_profile_name')).toBe('dev')
  })
})
