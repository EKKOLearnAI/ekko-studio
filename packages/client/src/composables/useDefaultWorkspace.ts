import { computed, ref } from 'vue'
import { getApiKey, getBaseUrlValue } from '@/api/client'
import {
  fetchWorkspaceDirectories, recordWorkspaceDirectory, setWorkspaceDirectoryFavorite, sameWorkspaceDirectoryPath,
  type WorkspaceDirectoriesResponse, type WorkspaceDirectory,
} from '@/api/studio/workspace-directories'

export function useDefaultWorkspace() {
  const directories = ref<WorkspaceDirectory[]>([])
  const defaultWorkspaces = computed(() => directories.value.filter(entry => entry.isFavorite).map(entry => entry.path))
  const recentWorkspaces = computed(() => directories.value.filter(entry => entry.lastUsed > 0)
    .sort((a, b) => b.lastUsed - a.lastUsed).slice(0, 10))
  let scope = ''
  let revision = 0
  let pending = Promise.resolve()

  function currentScope() { return `${getBaseUrlValue()}:${getApiKey()}` }
  function prepare() {
    const next = currentScope()
    if (next !== scope) { scope = next; directories.value = []; revision++ }
    return scope
  }
  function apply(result: WorkspaceDirectoriesResponse, expectedScope: string, expectedRevision: number) {
    if (currentScope() === expectedScope && scope === expectedScope && revision === expectedRevision) {
      directories.value = result.directories
    }
  }
  function init() { return mutate(fetchWorkspaceDirectories) }
  function mutate(operation: () => Promise<WorkspaceDirectoriesResponse>): Promise<void> {
    const expectedScope = prepare()
    const task = pending.catch(() => {}).then(async () => {
      if (currentScope() !== expectedScope) return
      const expectedRevision = ++revision
      apply(await operation(), expectedScope, expectedRevision)
    })
    pending = task
    return task
  }
  function addDefaultWorkspace(path: string) { return mutate(() => setWorkspaceDirectoryFavorite(path, true)) }
  function removeDefaultWorkspace(path: string) { return mutate(() => setWorkspaceDirectoryFavorite(path, false)) }
  function toggleDefaultWorkspace(path: string) {
    return mutate(() => setWorkspaceDirectoryFavorite(path, !isDefaultWorkspace(path)))
  }
  function isDefaultWorkspace(path: string) {
    return defaultWorkspaces.value.some(saved => sameWorkspaceDirectoryPath(saved, path))
  }
  function recordWorkspaceUsage(path: string) { return mutate(() => recordWorkspaceDirectory(path)) }
  function getMostRecentDefaultWorkspace(): string | null {
    return recentWorkspaces.value.find(entry => entry.isFavorite)?.path || defaultWorkspaces.value[0] || null
  }

  return { defaultWorkspaces, recentWorkspaces, init, addDefaultWorkspace, removeDefaultWorkspace, toggleDefaultWorkspace, isDefaultWorkspace,
    recordWorkspaceUsage, getMostRecentDefaultWorkspace }
}
