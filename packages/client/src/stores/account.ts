import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { getStoredUsername } from '@/api/client'
import { fetchCurrentUser, fetchMyAvatar, type UserAvatar } from '@/api/studio/auth'

export const useAccountStore = defineStore('account', () => {
  const username = ref(getStoredUsername() || '')
  const avatar = ref<UserAvatar | null>(null)
  const profileAvatar = computed(() => avatar.value?.type === 'image'
    ? { type: 'image' as const, dataUrl: avatar.value.dataUrl }
    : null)
  let loaded = false
  let pending: Promise<void> | null = null

  function loadAccount(): Promise<void> {
    if (pending) return pending
    if (loaded) return Promise.resolve()
    pending = Promise.allSettled([fetchCurrentUser(), fetchMyAvatar()])
      .then(([userResult, avatarResult]) => {
        if (userResult.status === 'fulfilled') username.value = userResult.value.username
        if (avatarResult.status === 'fulfilled') avatar.value = avatarResult.value
        loaded = userResult.status === 'fulfilled' && avatarResult.status === 'fulfilled'
      })
      .finally(() => { pending = null })
    return pending
  }

  return { username, avatar, profileAvatar, loadAccount }
})
