// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import GroupChatView from '@/views/hermes/GroupChatView.vue'
import { useGroupChatStore } from '@/stores/hermes/group-chat'
import { useSettingsStore } from '@/stores/hermes/settings'

vi.mock('@/components/common/PageLoading.vue', () => ({
  default: { props: ['show'], template: '<div><slot /></div>' },
}))

vi.mock('@/components/hermes/group-chat/GroupChatPanel.vue', () => ({
  default: { template: '<div data-testid="group-chat-panel" />' },
}))

const mockRoute = {
  params: {},
}
const mockReplace = vi.fn()

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRoute: () => mockRoute,
    useRouter: () => ({ replace: mockReplace }),
  }
})

describe('GroupChatView settings preload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
  })

  it('loads display settings when entering group chat directly', async () => {
    const groupStore = useGroupChatStore()
    const settingsStore = useSettingsStore()
    vi.spyOn(groupStore, 'connect').mockImplementation(() => undefined)
    vi.spyOn(groupStore, 'loadRooms').mockResolvedValue(undefined as any)
    vi.spyOn(settingsStore, 'fetchSettings').mockResolvedValue(undefined as any)

    mount(GroupChatView)
    await flushPromises()

    expect(groupStore.connect).toHaveBeenCalledOnce()
    expect(groupStore.loadRooms).toHaveBeenCalledOnce()
    expect(settingsStore.fetchSettings).toHaveBeenCalledOnce()
  })

  it('keeps the application-level group socket connected after leaving the group-chat route', async () => {
    const groupStore = useGroupChatStore()
    vi.spyOn(groupStore, 'connect').mockImplementation(() => undefined)
    vi.spyOn(groupStore, 'loadRooms').mockResolvedValue(undefined as any)
    vi.spyOn(groupStore, 'disconnect')
    vi.spyOn(useSettingsStore(), 'fetchSettings').mockResolvedValue(undefined as any)

    const wrapper = mount(GroupChatView)
    await flushPromises()
    wrapper.unmount()

    expect(groupStore.disconnect).not.toHaveBeenCalled()
  })
})
