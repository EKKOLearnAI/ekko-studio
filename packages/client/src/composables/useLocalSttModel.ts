import { useSettingsApi, useSettingsProfileScope } from '@/composables/useSettingsProfile'
import { ref } from 'vue'
import * as settingsApi0 from '@/api/studio/local-stt-model'
import type { LocalSttModelDownloadSource, LocalSttModelStatus } from '@/api/studio/local-stt-model'


const sharedStatus = ref<LocalSttModelStatus | null>(null)
const sharedLoading = ref(false)

export function useLocalSttModel() {
  const settingsScope = useSettingsProfileScope()
  const status = settingsScope ? ref<LocalSttModelStatus | null>(null) : sharedStatus
  const loading = settingsScope ? ref(false) : sharedLoading
  const { downloadLocalSttModel, fetchLocalSttModelStatus } = useSettingsApi(settingsApi0)
  async function refresh(): Promise<LocalSttModelStatus> {
    loading.value = true
    try {
      const next = await fetchLocalSttModelStatus()
      status.value = next
      return next
    } finally {
      loading.value = false
    }
  }

  async function download(source: LocalSttModelDownloadSource): Promise<void> {
    const response = await downloadLocalSttModel(source)
    status.value = status.value
      ? { ...status.value, job: response.job }
      : await refresh()
  }

  return { status, loading, refresh, download }
}
