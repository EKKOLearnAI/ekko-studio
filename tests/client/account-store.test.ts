import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  fetchCurrentUser: vi.fn(),
  fetchMyAvatar: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  getStoredUsername: () => '',
  isStoredSuperAdmin: () => false,
}))

vi.mock('@/api/studio/auth', () => ({
  fetchCurrentUser: mocks.fetchCurrentUser,
  fetchMyAvatar: mocks.fetchMyAvatar,
}))

import { useAccountStore } from '@/stores/account'

describe('account access state', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.fetchCurrentUser.mockReset()
    mocks.fetchMyAvatar.mockReset()
    mocks.fetchMyAvatar.mockResolvedValue(null)
  })

  it('updates super-admin access after the account response resolves', async () => {
    mocks.fetchCurrentUser.mockResolvedValue({
      id: 1,
      username: 'admin',
      role: 'super_admin',
      status: 'active',
      created_at: 0,
      updated_at: 0,
      last_login_at: null,
    })

    const store = useAccountStore()
    expect(store.isSuperAdmin).toBe(false)

    await store.loadAccount()

    expect(store.role).toBe('super_admin')
    expect(store.isSuperAdmin).toBe(true)
  })

  it('keeps the robot entry permission false for an ordinary admin', async () => {
    mocks.fetchCurrentUser.mockResolvedValue({
      id: 2,
      username: 'operator',
      role: 'admin',
      status: 'active',
      created_at: 0,
      updated_at: 0,
      last_login_at: null,
    })

    const store = useAccountStore()
    await store.loadAccount()

    expect(store.role).toBe('admin')
    expect(store.isSuperAdmin).toBe(false)
  })
})
