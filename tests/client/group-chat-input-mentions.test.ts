// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createTestingPinia } from '@pinia/testing'
import { nextTick } from 'vue'
import GroupChatInput from '@/components/hermes/group-chat/GroupChatInput.vue'
import { useGroupChatStore } from '@/stores/hermes/group-chat'
import { useSettingsStore } from '@/stores/hermes/settings'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  NButton: { emits: ['click'], template: '<button type="button" v-bind="$attrs" @click="$emit(\'click\', $event)"><slot /><slot name="icon" /></button>' },
  NTooltip: { template: '<div><slot name="trigger" /><slot /></div>' },
  NModal: { template: '<div><slot /><slot name="footer" /></div>' },
  NSwitch: { template: '<button type="button"></button>' },
  NDropdown: { template: '<div><slot /></div>' },
}))

vi.mock('@/composables/useToolTraceVisibility', () => ({
  useToolTraceVisibility: () => ({ toolTraceVisible: { value: true }, toggleToolTraceVisible: vi.fn() }),
}))

describe('GroupChatInput mentions', () => {
  beforeEach(() => {
    localStorage.clear()
    window.innerWidth = 1024
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:group-attachment'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    })
  })

  it('adds a pasted non-image file to the attachment list', async () => {
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
    const settingsStore = useSettingsStore()
    settingsStore.display = {}
    const file = new File(['hello'], 'group-notes.txt', { type: 'text/plain' })
    const wrapper = mount(GroupChatInput, {
      global: { plugins: [pinia], stubs: { Transition: false } },
    })
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: {
        items: [{ kind: 'file', type: file.type, getAsFile: () => file }],
        files: [file],
      },
    })

    wrapper.get('textarea').element.dispatchEvent(paste)
    await nextTick()

    expect(paste.defaultPrevented).toBe(true)
    expect(wrapper.get('.attachment-file').text()).toContain('group-notes.txt')
  })

  it('opens an uploaded image preview before sending', async () => {
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
    const settingsStore = useSettingsStore()
    settingsStore.display = {}
    const wrapper = mount(GroupChatInput, {
      global: { plugins: [pinia], stubs: { Transition: false } },
    })
    const image = new File(['image'], 'group-screenshot.png', { type: 'image/png' })
    const input = wrapper.get('input[type="file"]')
    Object.defineProperty(input.element, 'files', { configurable: true, value: [image] })

    await input.trigger('change')
    await nextTick()
    await wrapper.get('.attachment-thumb-button').trigger('click')
    await nextTick()

    expect(document.body.querySelector('.image-preview-overlay img')?.getAttribute('src'))
      .toBe('blob:group-attachment')
  })

  it('updates mention suggestions after the textarea has a custom height', async () => {
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
    const settingsStore = useSettingsStore()
    settingsStore.display = {}
    const store = useGroupChatStore()
    store.agents = [{ id: 'agent-1', agentId: 'agent-1', profile: 'worker', name: 'Worker', roomId: 'room-1', description: '', invited: 1 }]
    store.emitTyping = vi.fn()

    const wrapper = mount(GroupChatInput, {
      attachTo: document.body,
      global: { plugins: [pinia], stubs: { Transition: false } },
    })

    const textarea = wrapper.get('textarea')
    const resizeHandle = wrapper.get('.resize-handle')
    await resizeHandle.trigger('mousedown', { clientY: 100 })
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: 50 }))
    document.dispatchEvent(new MouseEvent('mouseup'))
    await nextTick()

    await textarea.setValue('@')
    await nextTick()
    expect(wrapper.find('.mention-dropdown').exists()).toBe(true)
    expect(wrapper.find('.mention-dropdown').text()).toContain('@Worker')
  })

  it('inserts an agent mention at the current cursor from the avatar action', async () => {
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
    const settingsStore = useSettingsStore()
    settingsStore.display = {}
    const store = useGroupChatStore()
    store.emitTyping = vi.fn()
    const wrapper = mount(GroupChatInput, {
      attachTo: document.body,
      global: { plugins: [pinia], stubs: { Transition: false } },
    })
    const textarea = wrapper.get('textarea')

    await textarea.setValue('老板喊你')
    ;(textarea.element as HTMLTextAreaElement).setSelectionRange(5, 5)
    ;(wrapper.vm as any).insertMention('codex')
    await nextTick()

    expect((textarea.element as HTMLTextAreaElement).value).toBe('老板喊你 @codex ')
    expect(document.activeElement).toBe(textarea.element)
    expect(store.emitTyping).toHaveBeenCalled()

    wrapper.unmount()
  })

  it('uses the avatar agent id when historical agents have the same name', async () => {
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
    const settingsStore = useSettingsStore()
    settingsStore.display = {}
    const store = useGroupChatStore()
    store.agents = [
      { id: 'row-1', agentId: 'agent-1', profile: 'first', name: 'Alex', roomId: 'room-1', description: '', invited: 1 },
      { id: 'row-2', agentId: 'agent-2', profile: 'second', name: 'Alex', roomId: 'room-1', description: '', invited: 1 },
    ]
    store.emitTyping = vi.fn()
    const onSend = vi.fn()
    const wrapper = mount(GroupChatInput, {
      props: { onSend },
      global: { plugins: [pinia], stubs: { Transition: false } },
    })

    ;(wrapper.vm as any).insertMention('Alex', 'agent-2')
    ;(wrapper.vm as any).handleSend()

    expect(onSend).toHaveBeenCalledWith(
      '@Alex',
      undefined,
      [{ type: 'agent', participantId: 'agent-2', displayName: 'Alex' }],
    )
  })

  it('shows the active room reference outside the input and can cancel it', async () => {
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
    const settingsStore = useSettingsStore()
    settingsStore.display = {}
    const store = useGroupChatStore()
    store.currentRoomId = 'room-1'
    store.setMessageReference('room-1', {
      id: 'message-1',
      role: 'assistant',
      content: 'A referenced group response',
      sender: 'Worker',
    })

    const wrapper = mount(GroupChatInput, {
      global: { plugins: [pinia], stubs: { Transition: false } },
    })
    await nextTick()

    expect(wrapper.get('.message-reference-preview').text()).toContain('A referenced group response')
    expect(wrapper.get('.message-reference-preview').element.parentElement?.classList.contains('input-wrapper')).toBe(false)

    await wrapper.get('.message-reference-remove').trigger('click')
    expect(store.activeMessageReference).toBeNull()
  })

  it('automatically mentions a valid quoted agent once', async () => {
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
    const settingsStore = useSettingsStore()
    settingsStore.display = {}
    const store = useGroupChatStore()
    store.currentRoomId = 'room-1'
    store.userId = 'human-1'
    store.agents = [{ id: 'row-1', agentId: 'agent-1', profile: 'worker', name: 'Worker', roomId: 'room-1', description: '', invited: 1 }]
    const onSend = vi.fn()
    const wrapper = mount(GroupChatInput, {
      props: { onSend },
      global: { plugins: [pinia], stubs: { Transition: false } },
    })

    store.setMessageReference('room-1', {
      id: 'message-1',
      role: 'assistant',
      content: 'A referenced response',
      sender: 'Worker',
      senderId: 'agent-1',
    })
    await nextTick()

    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('@Worker ')
    await wrapper.get('textarea').setValue('@Worker please review')
    ;(wrapper.vm as any).handleSend()
    expect(onSend).toHaveBeenCalledWith(
      '@Worker please review',
      undefined,
      [{ type: 'agent', participantId: 'agent-1', displayName: 'Worker' }],
    )
    ;(wrapper.vm as any).completeSend(true)
    store.setMessageReference('room-1', {
      id: 'message-2',
      role: 'assistant',
      content: 'Another response',
      sender: 'Worker',
      senderId: 'agent-1',
    })
    await nextTick()
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('@Worker ')
  })

  it('clears structured mention metadata when its visible text is deleted', async () => {
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
    const settingsStore = useSettingsStore()
    settingsStore.display = {}
    const store = useGroupChatStore()
    store.currentRoomId = 'room-1'
    store.userId = 'human-1'
    store.agents = [{ id: 'row-1', agentId: 'agent-1', profile: 'worker', name: 'Worker', roomId: 'room-1', description: '', invited: 1 }]
    const onSend = vi.fn()
    const wrapper = mount(GroupChatInput, {
      props: { onSend },
      global: { plugins: [pinia], stubs: { Transition: false } },
    })

    store.setMessageReference('room-1', {
      id: 'message-1',
      role: 'assistant',
      content: 'A referenced response',
      sender: 'Worker',
      senderId: 'agent-1',
    })
    await nextTick()
    await wrapper.get('textarea').setValue('please review')
    ;(wrapper.vm as any).handleSend()

    expect(onSend).toHaveBeenCalledWith('please review', undefined, undefined)
  })

  it('keeps same-name mention identities independent when one token is deleted', async () => {
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
    const settingsStore = useSettingsStore()
    settingsStore.display = {}
    const store = useGroupChatStore()
    store.currentRoomId = 'room-1'
    store.userId = 'human-1'
    store.agents = [
      { id: 'row-1', agentId: 'agent-1', profile: 'first', name: 'Alex', roomId: 'room-1', description: '', invited: 1 },
      { id: 'row-2', agentId: 'agent-2', profile: 'second', name: 'Alex', roomId: 'room-1', description: '', invited: 1 },
    ]
    const onSend = vi.fn()
    const wrapper = mount(GroupChatInput, {
      props: { onSend },
      global: { plugins: [pinia], stubs: { Transition: false } },
    })
    store.setMessageReference('room-1', {
      id: 'first-alex',
      role: 'assistant',
      content: 'First',
      sender: 'Alex',
      senderId: 'agent-1',
    })
    await nextTick()
    store.setMessageReference('room-1', {
      id: 'second-alex',
      role: 'assistant',
      content: 'Second',
      sender: 'Alex',
      senderId: 'agent-2',
    })
    await nextTick()
    const textarea = wrapper.get('textarea')
    expect((textarea.element as HTMLTextAreaElement).value).toBe('@Alex @Alex ')

    await textarea.setValue('@Alex ')
    ;(wrapper.vm as any).handleSend()

    expect(onSend).toHaveBeenCalledWith(
      '@Alex',
      undefined,
      [{ type: 'agent', participantId: 'agent-2', displayName: 'Alex' }],
    )
  })

  it('does not auto-mention self or an invalid quoted sender', async () => {
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
    const settingsStore = useSettingsStore()
    settingsStore.display = {}
    const store = useGroupChatStore()
    store.currentRoomId = 'room-1'
    store.userId = 'human-1'
    const wrapper = mount(GroupChatInput, {
      global: { plugins: [pinia], stubs: { Transition: false } },
    })

    store.setMessageReference('room-1', {
      id: 'self',
      role: 'user',
      content: 'My message',
      sender: 'Me',
      senderId: 'human-1',
    })
    await nextTick()
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('')

    store.setMessageReference('room-1', {
      id: 'missing',
      role: 'assistant',
      content: 'Removed member',
      sender: 'Removed',
      senderId: 'removed-1',
    })
    await nextTick()
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('')
  })

  it('applies the configured desktop input height', async () => {
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
    const settingsStore = useSettingsStore()
    settingsStore.display = { chat_input_height: 168 }

    const wrapper = mount(GroupChatInput, {
      global: { plugins: [pinia], stubs: { Transition: false } },
    })

    await nextTick()

    expect((wrapper.get('textarea').element as HTMLTextAreaElement).style.height).toBe('168px')
    expect((wrapper.get('.input-wrapper').element as HTMLElement).style.minHeight).toBe('231px')
  })

  it('applies display setting changes after a manual resize', async () => {
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
    const settingsStore = useSettingsStore()
    settingsStore.display = {}

    const wrapper = mount(GroupChatInput, {
      global: { plugins: [pinia], stubs: { Transition: false } },
    })
    const resizeHandle = wrapper.get('.resize-handle')

    await resizeHandle.trigger('mousedown', { clientY: 100 })
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: 50 }))
    document.dispatchEvent(new MouseEvent('mouseup'))
    await nextTick()

    settingsStore.display.chat_input_height = 216
    await nextTick()

    expect((wrapper.get('textarea').element as HTMLTextAreaElement).style.height).toBe('216px')
    expect((wrapper.get('.input-wrapper').element as HTMLElement).style.minHeight).toBe('279px')
  })

  it('preserves mobile auto height when a desktop preference is configured', async () => {
    window.innerWidth = 640
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
    const settingsStore = useSettingsStore()
    settingsStore.display = { chat_input_height: 168 }

    const wrapper = mount(GroupChatInput, {
      global: { plugins: [pinia], stubs: { Transition: false } },
    })

    await nextTick()

    expect((wrapper.get('textarea').element as HTMLTextAreaElement).style.height).not.toBe('168px')
  })

  it('keeps the draft intact when room configuration blocks sending', async () => {
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
    const settingsStore = useSettingsStore()
    settingsStore.display = {}
    const onSendBlocked = vi.fn()
    const wrapper = mount(GroupChatInput, {
      props: { sendBlocked: true, onSendBlocked },
      global: { plugins: [pinia], stubs: { Transition: false } },
    })
    const textarea = wrapper.get('textarea')

    await textarea.setValue('@Worker keep this draft')
    ;(wrapper.vm as any).handleSend()

    expect(onSendBlocked).toHaveBeenCalledOnce()
    expect(wrapper.emitted('send')).toBeUndefined()
    expect((textarea.element as HTMLTextAreaElement).value).toBe('@Worker keep this draft')
  })

  it('restores isolated room drafts with routable structured mentions', async () => {
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
    const settingsStore = useSettingsStore()
    settingsStore.display = {}
    const store = useGroupChatStore()
    store.agents = [{ id: 'agent-1', agentId: 'agent-1', profile: 'worker', name: 'Worker', roomId: 'room-a', description: '', invited: 1 }]
    store.emitTyping = vi.fn()
    const onSend = vi.fn()
    const wrapper = mount(GroupChatInput, {
      props: { roomId: 'room-a', onSend },
      global: { plugins: [pinia], stubs: { Transition: false } },
    })

    ;(wrapper.vm as any).insertMention('Worker', 'agent-1')
    await wrapper.get('textarea').setValue('@Worker inspect room A')
    await nextTick()
    await wrapper.setProps({ roomId: 'room-b' })
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('')
    await wrapper.get('textarea').setValue('room B draft')
    await wrapper.setProps({ roomId: 'room-a' })
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('@Worker inspect room A')

    wrapper.unmount()
    const remounted = mount(GroupChatInput, {
      props: { roomId: 'room-a', onSend },
      global: { plugins: [pinia], stubs: { Transition: false } },
    })
    await nextTick()
    ;(remounted.vm as any).handleSend()

    expect(onSend).toHaveBeenCalledWith(
      '@Worker inspect room A',
      undefined,
      [{ type: 'agent', participantId: 'agent-1', displayName: 'Worker' }],
    )
  })

  it('clears only after async send success and retains the draft after failure', async () => {
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
    const settingsStore = useSettingsStore()
    settingsStore.display = {}
    const wrapper = mount(GroupChatInput, {
      props: { roomId: 'room-a' },
      global: { plugins: [pinia], stubs: { Transition: false } },
    })
    const textarea = wrapper.get('textarea')

    await textarea.setValue('keep until acknowledged')
    ;(wrapper.vm as any).handleSend()
    expect((textarea.element as HTMLTextAreaElement).value).toBe('keep until acknowledged')

    ;(wrapper.vm as any).completeSend(false)
    expect((textarea.element as HTMLTextAreaElement).value).toBe('keep until acknowledged')

    ;(wrapper.vm as any).handleSend()
    ;(wrapper.vm as any).completeSend(true)
    await nextTick()
    expect((textarea.element as HTMLTextAreaElement).value).toBe('')

    wrapper.unmount()
    const remounted = mount(GroupChatInput, {
      props: { roomId: 'room-a' },
      global: { plugins: [pinia], stubs: { Transition: false } },
    })
    await nextTick()
    expect((remounted.get('textarea').element as HTMLTextAreaElement).value).toBe('')
  })

  it('does not restore local attachments or reply references after remount', async () => {
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
    const settingsStore = useSettingsStore()
    settingsStore.display = {}
    const store = useGroupChatStore()
    store.currentRoomId = 'room-a'
    const wrapper = mount(GroupChatInput, {
      props: { roomId: 'room-a' },
      global: { plugins: [pinia], stubs: { Transition: false } },
    })
    ;(wrapper.vm as any).addFiles([new File(['draft'], 'draft.txt', { type: 'text/plain' })])
    store.setMessageReference('room-a', {
      id: 'message-1',
      role: 'assistant',
      content: 'Do not persist me',
      sender: 'Worker',
    })
    await wrapper.get('textarea').setValue('persist only text')
    wrapper.unmount()
    store.clearMessageReference('room-a')

    const remounted = mount(GroupChatInput, {
      props: { roomId: 'room-a' },
      global: { plugins: [pinia], stubs: { Transition: false } },
    })
    await nextTick()

    expect((remounted.get('textarea').element as HTMLTextAreaElement).value).toBe('persist only text')
    expect(remounted.find('.attachment-previews').exists()).toBe(false)
    expect(remounted.find('.message-reference-preview').exists()).toBe(false)
  })
})
