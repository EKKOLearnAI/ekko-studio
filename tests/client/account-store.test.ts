// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia, storeToRefs } from 'pinia'

const api = vi.hoisted(() => ({ fetchCurrentUser: vi.fn(), fetchMyAvatar: vi.fn() }))
vi.mock('@/api/studio/auth', () => api)
vi.mock('@/api/client', () => ({ getStoredUsername: () => 'cached-name' }))

import { useAccountStore } from '@/stores/account'

describe('shared account identity', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('shares one load across sidebar and settings and retains account edits on remount', async () => {
    api.fetchCurrentUser.mockResolvedValue({ username: 'server-name' })
    api.fetchMyAvatar.mockResolvedValue({ type: 'image', dataUrl: 'data:image/png;base64,fixture' })
    const sidebar = useAccountStore()
    const settings = useAccountStore()
    await Promise.all([sidebar.loadAccount(), settings.loadAccount()])
    expect(api.fetchCurrentUser).toHaveBeenCalledTimes(1)
    expect(api.fetchMyAvatar).toHaveBeenCalledTimes(1)
    expect(sidebar.username).toBe('server-name')
    expect(sidebar.profileAvatar?.dataUrl).toBe('data:image/png;base64,fixture')

    const { username, avatar } = storeToRefs(settings)
    username.value = 'renamed'
    avatar.value = { type: 'default' }
    await sidebar.loadAccount()
    expect(sidebar.username).toBe('renamed')
    expect(sidebar.profileAvatar).toBeNull()
    expect(api.fetchCurrentUser).toHaveBeenCalledTimes(1)
  })

  it('keeps a usable identity on load failure and retries on the next mount', async () => {
    api.fetchCurrentUser.mockRejectedValueOnce(new Error('offline'))
    api.fetchMyAvatar.mockResolvedValue(null)
    const account = useAccountStore()
    await account.loadAccount()
    expect(account.username).toBe('cached-name')
    expect(account.profileAvatar).toBeNull()
    api.fetchCurrentUser.mockResolvedValue({ username: 'recovered' })
    await account.loadAccount()
    expect(account.username).toBe('recovered')
  })
})
