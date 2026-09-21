import { ref } from 'vue'
import {
  downloadLocalSttModel,
  fetchLocalSttModelStatus,
  type LocalSttModelDownloadSource,
  type LocalSttModelStatus,
} from '@/api/studio/local-stt-model'

const status = ref<LocalSttModelStatus | null>(null)
const loading = ref(false)

export function useLocalSttModel() {
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
