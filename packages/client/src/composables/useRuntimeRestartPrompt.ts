import { readonly, ref } from 'vue'

export interface PendingRuntimeRestart {
  version: string
  jobId?: string
}

const runtimeDownloadCheckRevision = ref(0)
const pendingRuntimeRestart = ref<PendingRuntimeRestart | null>(null)

export function useRuntimeRestartPrompt() {
  function requestRuntimeRestart(version: string, jobId?: string) {
    if (pendingRuntimeRestart.value) return
    pendingRuntimeRestart.value = { version, ...(jobId ? { jobId } : {}) }
  }

  function clearRuntimeRestart() {
    pendingRuntimeRestart.value = null
  }

  function checkRuntimeDownloads() {
    runtimeDownloadCheckRevision.value += 1
  }

  return {
    runtimeDownloadCheckRevision: readonly(runtimeDownloadCheckRevision),
    checkRuntimeDownloads,
    pendingRuntimeRestart: readonly(pendingRuntimeRestart),
    requestRuntimeRestart,
    clearRuntimeRestart,
  }
}
