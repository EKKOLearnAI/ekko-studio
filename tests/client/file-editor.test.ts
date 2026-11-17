import { createPinia, setActivePinia } from 'pinia'
import { expect, it, vi } from 'vitest'
import { useFilesStore } from '@/stores/hermes/files'
import * as api from '@/api/studio/files'

vi.mock('@/api/client', () => ({ getActiveProfileName: () => 'default' }))
vi.mock('@/api/studio/files', () => ({ readFile: vi.fn(), writeFile: vi.fn() }))
vi.mock('@/api/studio/sessions', () => ({}))
vi.mock('@/api/studio/group-chat', () => ({}))

it('binds an explicit profile and only acknowledges the submitted text', async () => {
  setActivePinia(createPinia())
  const files = useFilesStore()
  files.currentWorkspaceRoomId = 'previous-room'
  vi.mocked(api.readFile).mockResolvedValue({ content: 'old', path: 'config.yaml', size: 3 })
  await files.openEditor('config.yaml', { profile: 'selected' })
  expect(api.readFile).toHaveBeenCalledWith('config.yaml', 'selected')
  const pending = Promise.withResolvers<void>()
  vi.mocked(api.writeFile).mockReturnValue(pending.promise)
  files.editingFile!.content = 'submitted'
  files.currentProfile = 'other'
  const save = files.saveEditor()
  files.editingFile!.content = 'still typing'
  pending.resolve()
  await save
  expect(api.writeFile).toHaveBeenCalledWith('config.yaml', 'submitted', 'selected')
  expect(files.editingFile!.originalContent).toBe('submitted')
  expect(files.hasUnsavedChanges).toBe(true)
})
