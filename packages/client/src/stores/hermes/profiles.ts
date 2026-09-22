import { defineStore } from 'pinia'
import { ref } from 'vue'
import * as profilesApi from '@/api/hermes/profiles'
import type { HermesProfile, HermesProfileDetail } from '@/api/hermes/profiles'
import { fetchAgentStatusSnapshot } from '@/api/agent-status'
import { useAppStore } from './app'

const ACTIVE_PROFILE_STORAGE_KEY = 'hermes_active_profile_name'

export const useProfilesStore = defineStore('profiles', () => {
  const profiles = ref<HermesProfile[]>([])
  // 初始化时同步读 localStorage，确保其他 store（如 chat）在启动时能拿到 profile name
  const activeProfileName = ref<string | null>(localStorage.getItem(ACTIVE_PROFILE_STORAGE_KEY))
  const activeProfile = ref<HermesProfile | null>(null)
  const detailMap = ref<Record<string, HermesProfileDetail>>({})
  const loading = ref(false)
  const switching = ref(false)
  const hermesAvailable = ref(false)

  async function fetchProfiles() {
    loading.value = true
    try {
      profiles.value = await profilesApi.fetchProfiles()
      const storedName = activeProfileName.value || localStorage.getItem(ACTIVE_PROFILE_STORAGE_KEY)
      let selected = profiles.value.find(p => p.name === storedName) ?? null
      if (!selected && profiles.value.length > 0) {
        selected = profiles.value[0]
        activeProfileName.value = selected.name
        localStorage.setItem(ACTIVE_PROFILE_STORAGE_KEY, selected.name)
      }
      profiles.value = profiles.value.map(profile => ({
        ...profile,
        active: !!selected && profile.name === selected.name,
      }))
      activeProfile.value = selected
      if (selected) {
        activeProfileName.value = selected.name
      } else {
        activeProfileName.value = null
        localStorage.removeItem(ACTIVE_PROFILE_STORAGE_KEY)
      }
      // 清理所有会话缓存（不再使用 localStorage 缓存）
      clearAllSessionCaches()
    } catch (err) {
      console.error('Failed to fetch profiles:', err)
    } finally {
      loading.value = false
    }
  }

  async function fetchHermesProfiles() {
    loading.value = true
    try {
      const [profilesResult, statusResult] = await Promise.allSettled([
        profilesApi.fetchProfiles(),
        fetchAgentStatusSnapshot(),
      ])
      if (profilesResult.status === 'rejected') throw profilesResult.reason
      profiles.value = profilesResult.value
      const hermes = statusResult.status === 'fulfilled'
        ? statusResult.value.agents.find(agent => agent.id === 'hermes')
        : undefined
      hermesAvailable.value = Boolean(
        hermes?.installed
        && hermes.source !== 'not-installed'
        && hermes.path,
      )
      activeProfile.value = profiles.value.find(profile => profile.active) ?? null
      clearAllSessionCaches()
    } catch (err) {
      hermesAvailable.value = false
      console.error('Failed to fetch Hermes profiles:', err)
    } finally {
      loading.value = false
    }
  }

  async function fetchProfileDetail(name: string) {
    if (detailMap.value[name]) return detailMap.value[name]
    try {
      const detail = await profilesApi.fetchProfileDetail(name)
      detailMap.value[name] = detail
      return detail
    } catch {
      return null
    }
  }

  async function updateAvatar(name: string, avatar: profilesApi.ProfileAvatar) {
    const saved = await profilesApi.updateProfileAvatar(name, avatar)
    profiles.value = profiles.value.map(profile => (
      profile.name === name ? { ...profile, avatar: saved } : profile
    ))
    if (detailMap.value[name]) {
      detailMap.value[name] = { ...detailMap.value[name], avatar: saved }
    }
    if (activeProfile.value?.name === name) {
      activeProfile.value = { ...activeProfile.value, avatar: saved }
    }
    return saved
  }

  async function deleteAvatar(name: string) {
    await profilesApi.deleteProfileAvatar(name)
    profiles.value = profiles.value.map(profile => (
      profile.name === name ? { ...profile, avatar: null } : profile
    ))
    if (detailMap.value[name]) {
      detailMap.value[name] = { ...detailMap.value[name], avatar: null }
    }
    if (activeProfile.value?.name === name) {
      activeProfile.value = { ...activeProfile.value, avatar: null }
    }
  }

  async function createProfile(name: string, cloneFrom?: string | null) {
    const res = await profilesApi.createProfile(name, cloneFrom)
    if (res.success) await fetchProfiles()
    return res
  }

  async function deleteProfile(name: string) {
    const ok = await profilesApi.deleteProfile(name)
    if (ok) {
      delete detailMap.value[name]
      await fetchProfiles()
    }
    return ok
  }

  // 清理所有 profile 的会话缓存
  function clearAllSessionCaches() {
    // 注意：不再清理任何缓存，因为已经不再使用 localStorage 缓存会话数据
    // 所有会话数据都从服务器实时获取
  }

  async function renameProfile(name: string, newName: string) {
    const ok = await profilesApi.renameProfile(name, newName)
    if (ok) {
      delete detailMap.value[name]
      await fetchProfiles()
    }
    return ok
  }

  async function switchProfile(name: string) {
    switching.value = true
    try {
      const ok = await profilesApi.switchProfile(name)
      if (ok) {
        activeProfileName.value = name
        localStorage.setItem(ACTIVE_PROFILE_STORAGE_KEY, name)
        profiles.value = profiles.value.map(profile => ({
          ...profile,
          active: profile.name === name,
        }))
        activeProfile.value = profiles.value.find(profile => profile.name === name) ?? null
        await useAppStore().reloadModels()
      }
      return ok
    } finally {
      switching.value = false
    }
  }

  async function switchHermesProfile(name: string) {
    switching.value = true
    try {
      const ok = await profilesApi.switchHermesProfile(name)
      if (ok) await fetchHermesProfiles()
      return ok
    } finally {
      switching.value = false
    }
  }

  async function exportProfile(name: string) {
    return profilesApi.exportProfile(name)
  }

  async function importProfile(file: File) {
    const result = await profilesApi.importProfile(file)
    if (result.success) await fetchProfiles()
    return result
  }

  return {
    profiles,
    activeProfile,
    activeProfileName,
    detailMap,
    loading,
    switching,
    hermesAvailable,
    fetchProfiles,
    fetchHermesProfiles,
    fetchProfileDetail,
    createProfile,
    deleteProfile,
    renameProfile,
    switchProfile,
    switchHermesProfile,
    exportProfile,
    importProfile,
    updateAvatar,
    deleteAvatar,
    clearAllSessionCaches,
  }
})
