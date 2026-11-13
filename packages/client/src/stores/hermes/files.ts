import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import * as filesApi from '@/api/studio/files'
import {
  copySessionWorkspaceFile,
  deleteSessionWorkspaceFile,
  fetchSessionWorkspaceFileText,
  listSessionWorkspaceFiles,
  mkdirSessionWorkspaceFile,
  readSessionWorkspaceFile,
  renameSessionWorkspaceFile,
  writeSessionWorkspaceFile,
} from '@/api/studio/sessions'
import type { FileEntry, FileListResult } from '@/api/studio/files'
import {
  copyGroupWorkspaceFile,
  deleteGroupWorkspaceFile,
  fetchGroupWorkspaceFileText,
  listGroupWorkspaceFiles,
  mkdirGroupWorkspaceFile,
  readGroupWorkspaceFile,
  renameGroupWorkspaceFile,
  writeGroupWorkspaceFile,
} from '@/api/studio/group-chat'
import {
  getFilePreviewKind,
  getTextPreviewLanguage,
  type FilePreviewKind,
} from '@/utils/hermes/file-preview'
import { fetchAuthenticatedBlob } from '@/api/studio/binary-content'

export { isImageFile, isMarkdownFile, isPreviewableFile, isTextFile } from '@/utils/hermes/file-preview'

export function getLanguageFromPath(filePath: string): string {
  return getTextPreviewLanguage(filePath) || 'plaintext'
}

export type FilePreviewLocation = {
  startLine: number
  endLine?: number
}

// Returns true if `targetPath` is the same as `changedPath` or lives inside it
// when `changedIsDir` is true. Used to invalidate preview/editor state when
// the underlying file is deleted or renamed.
function isAffected(targetPath: string, changedPath: string, changedIsDir: boolean): boolean {
  if (targetPath === changedPath) return true
  if (changedIsDir && targetPath.startsWith(changedPath + '/')) return true
  return false
}

function normalizeProfile(profile?: string | null): string | null {
  const value = typeof profile === 'string' ? profile.trim() : ''
  return value || null
}

export const useFilesStore = defineStore('files', () => {
  const currentPath = ref('')
  const currentProfile = ref<string | null>(null)
  const currentWorkspaceSessionId = ref<string | null>(null)
  const currentWorkspaceRoomId = ref<string | null>(null)
  const entries = ref<FileEntry[]>([])
  const loading = ref(false)
  const sortBy = ref<'name' | 'size' | 'modTime'>('name')
  const sortOrder = ref<'asc' | 'desc'>('asc')
  let fetchRequestSeq = 0
  let previewRequestSeq = 0

  const editingFile = ref<{
    path: string
    content: string
    originalContent: string
    language: string
    workspaceSessionId?: string
    workspaceRoomId?: string
    workspaceRelativePath?: string
  } | null>(null)

  const previewFile = ref<{
    path: string
    name: string
    size: number
    profile?: string | null
    workspaceSessionId?: string | null
    workspaceRoomId?: string | null
    sourceUrl?: string
    type: FilePreviewKind
    content?: string
    language?: string
    startLine?: number
    endLine?: number
  } | null>(null)

  function beginPreviewRequest(): number {
    return ++previewRequestSeq
  }

  function commitPreview(requestSeq: number, file: NonNullable<typeof previewFile.value>): void {
    if (requestSeq !== previewRequestSeq) return
    previewFile.value = file
  }

  const pathSegments = computed(() => {
    if (!currentPath.value) return []
    return currentPath.value.split('/').filter(Boolean)
  })

  const sortedEntries = computed(() => {
    const copy = [...entries.value]
    copy.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      let cmp = 0
      switch (sortBy.value) {
        case 'name': cmp = a.name.localeCompare(b.name); break
        case 'size': cmp = a.size - b.size; break
        case 'modTime': cmp = a.modTime.localeCompare(b.modTime); break
      }
      return sortOrder.value === 'asc' ? cmp : -cmp
    })
    return copy
  })

  function resolveProfile(profile?: string | null): string | null {
    return currentWorkspaceSessionId.value || currentWorkspaceRoomId.value ? null : profile === undefined ? currentProfile.value : normalizeProfile(profile)
  }

  function resolveWorkspaceSessionId(sessionId?: string | null): string | null {
    return sessionId === undefined ? currentWorkspaceSessionId.value : normalizeProfile(sessionId)
  }

  function resolveWorkspaceRoomId(roomId?: string | null): string | null {
    return roomId === undefined ? currentWorkspaceRoomId.value : normalizeProfile(roomId)
  }

  async function listEntries(path = currentPath.value): Promise<FileListResult> {
    const workspaceSessionId = currentWorkspaceSessionId.value
    const workspaceRoomId = currentWorkspaceRoomId.value
    if (workspaceRoomId) return listGroupWorkspaceFiles(workspaceRoomId, path)
    if (workspaceSessionId) return listSessionWorkspaceFiles(workspaceSessionId, path)
    return filesApi.listFiles(path, currentProfile.value)
  }

  async function fetchDirectory(path: string, options: { profile?: string | null } = {}) {
    const profile = resolveProfile(options.profile)
    return filesApi.listFiles(path, profile)
  }

  async function fetchEntries(path?: string, options: { profile?: string | null; workspaceSessionId?: string | null; workspaceRoomId?: string | null } = {}) {
    const requestSeq = ++fetchRequestSeq
    if (path !== undefined && path !== currentPath.value) {
      // Switching directory invalidates the current preview; close it so the
      // file list becomes visible again. The editor has its own dirty-check
      // (see hasUnsavedChanges), so we leave editingFile alone here.
      previewFile.value = null
    }
    const previousWorkspaceSessionId = currentWorkspaceSessionId.value
    const previousWorkspaceRoomId = currentWorkspaceRoomId.value
    const previousProfile = currentProfile.value
    const previousPath = currentPath.value
    let nextWorkspaceSessionId = resolveWorkspaceSessionId(options.workspaceSessionId)
    let nextWorkspaceRoomId = resolveWorkspaceRoomId(options.workspaceRoomId)
    if (options.workspaceSessionId !== undefined && nextWorkspaceSessionId) nextWorkspaceRoomId = null
    if (options.workspaceRoomId !== undefined && nextWorkspaceRoomId) nextWorkspaceSessionId = null
    currentWorkspaceSessionId.value = nextWorkspaceSessionId
    currentWorkspaceRoomId.value = nextWorkspaceRoomId
    const nextProfile = nextWorkspaceSessionId || nextWorkspaceRoomId ? null : resolveProfile(options.profile)
    currentProfile.value = nextProfile
    if (path !== undefined) currentPath.value = path
    if (
      previousWorkspaceSessionId !== nextWorkspaceSessionId ||
      previousWorkspaceRoomId !== nextWorkspaceRoomId ||
      previousProfile !== nextProfile ||
      previousPath !== currentPath.value
    ) {
      entries.value = []
    }
    loading.value = true
    try {
      const result = await listEntries(currentPath.value)
      if (requestSeq !== fetchRequestSeq) return
      entries.value = result.entries
    } catch (err) {
      if (requestSeq !== fetchRequestSeq) return
      console.error('Failed to fetch files:', err)
      if (nextWorkspaceSessionId || nextWorkspaceRoomId) entries.value = []
      throw err
    } finally {
      if (requestSeq === fetchRequestSeq) loading.value = false
    }
  }

  function navigateTo(path: string, options: { profile?: string | null; workspaceSessionId?: string | null; workspaceRoomId?: string | null } = {}) { return fetchEntries(path, options) }
  function navigateUp(options: { profile?: string | null; workspaceSessionId?: string | null; workspaceRoomId?: string | null } = {}) {
    const parts = currentPath.value.split('/').filter(Boolean)
    parts.pop()
    return fetchEntries(parts.join('/'), options)
  }

  async function openEditor(filePath: string, options: { profile?: string | null } = {}) {
    previewFile.value = null
    if (currentWorkspaceRoomId.value) {
      await openGroupWorkspaceEditor(currentWorkspaceRoomId.value, filePath)
      return
    }
    if (currentWorkspaceSessionId.value) {
      await openSessionWorkspaceEditor(currentWorkspaceSessionId.value, filePath)
      return
    }
    const profile = resolveProfile(options.profile)
    currentProfile.value = profile
    const result = await filesApi.readFile(filePath, profile)
    editingFile.value = {
      path: filePath,
      content: result.content,
      originalContent: result.content,
      language: getLanguageFromPath(filePath),
    }
  }

  async function openSessionWorkspaceEditor(sessionId: string, filePath: string) {
    previewFile.value = null
    const result = await readSessionWorkspaceFile(sessionId, filePath)
    editingFile.value = {
      path: result.path,
      content: result.content,
      originalContent: result.content,
      language: getLanguageFromPath(result.path),
      workspaceSessionId: sessionId,
      workspaceRelativePath: result.path,
    }
  }

  async function openGroupWorkspaceEditor(roomId: string, filePath: string) {
    previewFile.value = null
    const result = await readGroupWorkspaceFile(roomId, filePath)
    editingFile.value = {
      path: result.path,
      content: result.content,
      originalContent: result.content,
      language: getLanguageFromPath(result.path),
      workspaceRoomId: roomId,
      workspaceRelativePath: result.path,
    }
  }

  async function saveEditor() {
    if (!editingFile.value) return
    if (editingFile.value.workspaceRoomId && editingFile.value.workspaceRelativePath) {
      await writeGroupWorkspaceFile(
        editingFile.value.workspaceRoomId,
        editingFile.value.workspaceRelativePath,
        editingFile.value.content,
      )
    } else if (editingFile.value.workspaceSessionId && editingFile.value.workspaceRelativePath) {
      await writeSessionWorkspaceFile(
        editingFile.value.workspaceSessionId,
        editingFile.value.workspaceRelativePath,
        editingFile.value.content,
      )
    } else {
      await filesApi.writeFile(editingFile.value.path, editingFile.value.content, currentProfile.value)
    }
    editingFile.value.originalContent = editingFile.value.content
  }

  function closeEditor() { editingFile.value = null }

  async function openPreview(entry: FileEntry, options: { profile?: string | null } = {}) {
    const profile = resolveProfile(options.profile)
    currentProfile.value = profile
    const type = getFilePreviewKind(entry.name)
    if (!type) return
    editingFile.value = null
    const common = {
      path: entry.path,
      name: entry.name,
      size: entry.size,
      profile,
      workspaceSessionId: currentWorkspaceSessionId.value,
      ...(currentWorkspaceRoomId.value ? { workspaceRoomId: currentWorkspaceRoomId.value } : {}),
      type,
    }
    if (type === 'markdown') {
      const result = currentWorkspaceRoomId.value
        ? await readGroupWorkspaceFile(currentWorkspaceRoomId.value, entry.path)
        : currentWorkspaceSessionId.value
          ? await readSessionWorkspaceFile(currentWorkspaceSessionId.value, entry.path)
          : await filesApi.readFile(entry.path, profile)
      previewFile.value = { ...common, content: result.content }
    } else if (type === 'text') {
      const result = currentWorkspaceRoomId.value
        ? await readGroupWorkspaceFile(currentWorkspaceRoomId.value, entry.path)
        : currentWorkspaceSessionId.value
          ? await readSessionWorkspaceFile(currentWorkspaceSessionId.value, entry.path)
          : await filesApi.readFile(entry.path, profile)
      previewFile.value = {
        ...common,
        content: result.content,
        language: getLanguageFromPath(entry.path),
      }
    } else {
      previewFile.value = common
    }
  }

  async function openSessionWorkspacePreview(
    sessionId: string,
    filePath: string,
    fileName = filePath.split('/').pop() || filePath,
    size = -1,
    location?: FilePreviewLocation,
  ) {
    const type = getFilePreviewKind(fileName || filePath)
    if (!type) return
    const requestSeq = beginPreviewRequest()
    const common = {
      path: filePath,
      name: fileName,
      size,
      profile: null,
      workspaceSessionId: sessionId,
      type,
      ...(location ? {
        startLine: location.startLine,
        endLine: location.endLine ?? location.startLine,
      } : {}),
    }
    if (type === 'markdown' || type === 'text') {
      const result = await fetchSessionWorkspaceFileText(sessionId, filePath)
      commitPreview(requestSeq, type === 'markdown'
        ? { ...common, size: result.size, content: result.content }
        : {
            ...common,
            size: result.size,
            content: result.content,
            language: getLanguageFromPath(filePath),
          })
      return
    }
    commitPreview(requestSeq, common)
  }

  async function openGroupWorkspacePreview(
    roomId: string,
    filePath: string,
    fileName = filePath.split('/').pop() || filePath,
    size = -1,
    location?: FilePreviewLocation,
  ) {
    const type = getFilePreviewKind(fileName || filePath)
    if (!type) return
    const requestSeq = beginPreviewRequest()
    const common = {
      path: filePath,
      name: fileName,
      size,
      profile: null,
      workspaceSessionId: null,
      workspaceRoomId: roomId,
      type,
      ...(location ? {
        startLine: location.startLine,
        endLine: location.endLine ?? location.startLine,
      } : {}),
    }
    if (type === 'markdown' || type === 'text') {
      const result = await fetchGroupWorkspaceFileText(roomId, filePath)
      commitPreview(requestSeq, type === 'markdown'
        ? { ...common, size: result.size, content: result.content }
        : { ...common, size: result.size, content: result.content, language: getLanguageFromPath(filePath) })
      return
    }
    commitPreview(requestSeq, common)
  }

  async function openRemotePreview(
    sourceUrl: string,
    fileName: string,
    size = -1,
    context: { workspaceSessionId?: string | null; workspaceRoomId?: string | null } = {},
  ): Promise<boolean> {
    const type = getFilePreviewKind(fileName)
    if (!type) return false
    const common = {
      path: fileName,
      name: fileName,
      size,
      profile: null,
      sourceUrl,
      type,
      ...context,
    }
    if (type === 'markdown' || type === 'text') {
      const blob = await fetchAuthenticatedBlob(sourceUrl, { profile: null })
      const content = await blob.text()
      previewFile.value = type === 'markdown'
        ? { ...common, content }
        : { ...common, content, language: getLanguageFromPath(fileName) }
      return true
    }
    previewFile.value = common
    return true
  }

  function closePreview() {
    previewRequestSeq += 1
    previewFile.value = null
  }

  function selectDirectory(path: string) { currentPath.value = path }

  async function createDir(name: string, targetPath = currentPath.value) {
    const path = targetPath ? `${targetPath}/${name}` : name
    if (currentWorkspaceRoomId.value) await mkdirGroupWorkspaceFile(currentWorkspaceRoomId.value, path)
    else if (currentWorkspaceSessionId.value) await mkdirSessionWorkspaceFile(currentWorkspaceSessionId.value, path)
    else await filesApi.mkDir(path, currentProfile.value)
    await fetchEntries(undefined)
  }

  async function createFile(name: string) {
    const path = currentPath.value ? `${currentPath.value}/${name}` : name
    if (currentWorkspaceRoomId.value) await writeGroupWorkspaceFile(currentWorkspaceRoomId.value, path, '')
    else if (currentWorkspaceSessionId.value) await writeSessionWorkspaceFile(currentWorkspaceSessionId.value, path, '')
    else await filesApi.writeFile(path, '', currentProfile.value)
    await fetchEntries(undefined)
  }

  async function deleteEntry(entry: FileEntry) {
    if (currentWorkspaceRoomId.value) await deleteGroupWorkspaceFile(currentWorkspaceRoomId.value, entry.path, entry.isDir)
    else if (currentWorkspaceSessionId.value) await deleteSessionWorkspaceFile(currentWorkspaceSessionId.value, entry.path, entry.isDir)
    else await filesApi.deleteFile(entry.path, entry.isDir, currentProfile.value)
    if (previewFile.value && isAffected(previewFile.value.path, entry.path, entry.isDir)) {
      previewFile.value = null
    }
    if (editingFile.value && isAffected(editingFile.value.path, entry.path, entry.isDir)) {
      editingFile.value = null
    }
    await fetchEntries(undefined)
  }

  async function renameEntry(entry: FileEntry, newName: string) {
    const parentPath = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''
    const newPath = parentPath ? `${parentPath}/${newName}` : newName
    if (currentWorkspaceRoomId.value) await renameGroupWorkspaceFile(currentWorkspaceRoomId.value, entry.path, newPath)
    else if (currentWorkspaceSessionId.value) await renameSessionWorkspaceFile(currentWorkspaceSessionId.value, entry.path, newPath)
    else await filesApi.renameFile(entry.path, newPath, currentProfile.value)
    if (previewFile.value && isAffected(previewFile.value.path, entry.path, entry.isDir)) {
      previewFile.value = null
    }
    if (editingFile.value && isAffected(editingFile.value.path, entry.path, entry.isDir)) {
      editingFile.value = null
    }
    await fetchEntries(undefined)
  }

  async function copyEntry(entry: FileEntry, destPath: string) {
    if (currentWorkspaceRoomId.value) await copyGroupWorkspaceFile(currentWorkspaceRoomId.value, entry.path, destPath)
    else if (currentWorkspaceSessionId.value) await copySessionWorkspaceFile(currentWorkspaceSessionId.value, entry.path, destPath)
    else await filesApi.copyFile(entry.path, destPath, currentProfile.value)
    await fetchEntries(undefined)
  }

  async function uploadFiles(files: File[]) {
    if (!currentWorkspaceSessionId.value && !currentWorkspaceRoomId.value) {
      await filesApi.uploadFiles(currentPath.value, files, currentProfile.value)
      await fetchEntries(undefined)
      return
    }
    for (const file of files) {
      const path = currentPath.value ? `${currentPath.value}/${file.name}` : file.name
      const content = await file.text()
      if (currentWorkspaceRoomId.value) await writeGroupWorkspaceFile(currentWorkspaceRoomId.value, path, content)
      else await writeSessionWorkspaceFile(currentWorkspaceSessionId.value!, path, content)
    }
    await fetchEntries(undefined)
  }

  function setSort(by: 'name' | 'size' | 'modTime') {
    if (sortBy.value === by) {
      sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc'
    } else {
      sortBy.value = by
      sortOrder.value = 'asc'
    }
  }

  const hasUnsavedChanges = computed(() => {
    if (!editingFile.value) return false
    return editingFile.value.content !== editingFile.value.originalContent
  })

  return {
    currentPath, currentProfile, currentWorkspaceSessionId, currentWorkspaceRoomId, entries, loading, sortBy, sortOrder,
    editingFile, previewFile,
    pathSegments, sortedEntries, hasUnsavedChanges,
    fetchEntries, listEntries, fetchDirectory, navigateTo, navigateUp, selectDirectory,
    openEditor, openSessionWorkspaceEditor, openGroupWorkspaceEditor, saveEditor, closeEditor,
    openPreview, openSessionWorkspacePreview, openGroupWorkspacePreview, openRemotePreview, closePreview,
    createDir, createFile, deleteEntry, renameEntry, copyEntry,
    uploadFiles, setSort,
  }
})
