import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  fetchWorkspaceRunChangeFile,
  type WorkspaceRunChangeFileSummary,
} from '@/api/studio/sessions'

export interface WorkspaceDiffPanelState {
  file: WorkspaceRunChangeFileSummary | {
    id: string | number
    path: string
    additions: number
    deletions: number
    binary: boolean
    session_id?: string
    change_id?: string
  }
  workspace: string
  patch: string
  loading: boolean
  unavailable: boolean
  editable: boolean
}

export const useToolPanelStore = defineStore('hermes-tool-panel', () => {
  const workspaceDiff = ref<WorkspaceDiffPanelState | null>(null)
  let requestGeneration = 0

  async function openWorkspaceDiff(file: WorkspaceRunChangeFileSummary, workspace = ''): Promise<void> {
    const generation = ++requestGeneration
    workspaceDiff.value = {
      file,
      workspace,
      patch: '',
      loading: !file.binary,
      unavailable: false,
      editable: true,
    }
    if (file.binary) return

    try {
      const detail = await fetchWorkspaceRunChangeFile(file.session_id, file.change_id, file.id)
      if (generation !== requestGeneration || workspaceDiff.value?.file.id !== file.id) return
      workspaceDiff.value.patch = detail?.patch || ''
      workspaceDiff.value.unavailable = !detail?.patch
      workspaceDiff.value.loading = false
    } catch {
      if (generation !== requestGeneration || workspaceDiff.value?.file.id !== file.id) return
      workspaceDiff.value.patch = ''
      workspaceDiff.value.unavailable = true
      workspaceDiff.value.loading = false
    }
  }

  function openInlineWorkspaceDiff(
    file: WorkspaceDiffPanelState['file'],
    patch: string | null | undefined,
    workspace = '',
  ): void {
    requestGeneration += 1
    workspaceDiff.value = {
      file,
      workspace,
      patch: patch || '',
      loading: false,
      unavailable: !file.binary && !patch,
      editable: false,
    }
  }

  function closeWorkspaceDiff(): void {
    requestGeneration += 1
    workspaceDiff.value = null
  }

  return {
    workspaceDiff,
    openWorkspaceDiff,
    openInlineWorkspaceDiff,
    closeWorkspaceDiff,
  }
})
