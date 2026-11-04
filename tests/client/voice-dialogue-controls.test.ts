// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import VoiceDialogueControls from '../../packages/client/src/components/hermes/chat/VoiceDialogueControls.vue'
import type { VoiceDialogueStatus } from '../../packages/client/src/components/hermes/chat/VoiceTranscriptOverlay.vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string, values?: Record<string, string>) => values?.error || values?.text || values?.status || key }),
}))

let wrapper: VueWrapper | undefined

function renderControls(props: { status?: VoiceDialogueStatus; transcript?: string; error?: string | null } = {}) {
  const callbacks = { onStart: vi.fn(), onStop: vi.fn(), onCancel: vi.fn() }
  const control = mount(VoiceDialogueControls, {
    attachTo: document.body,
    props: { status: 'idle', transcript: '', error: 'Configure STT first', ...callbacks, ...props },
  })
  wrapper = control
  return { control, ...callbacks }
}

async function pointerDown(target: Element = document.body) {
  target.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  await nextTick()
}

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.restoreAllMocks()
})

describe('voice input hint dismissal', () => {
  it.each(['idle', 'error'] as const)('dismisses an inactive %s hint on outside pointerdown without changing the error', async (status) => {
    const { control, onStart, onStop, onCancel } = renderControls({ status })
    expect(control.get('[role="alert"]').text()).toBe('Configure STT first')

    await pointerDown()

    expect(control.find('[data-testid="voice-transcript-overlay"]').exists()).toBe(false)
    expect(control.props('error')).toBe('Configure STT first')
    expect(onStart).not.toHaveBeenCalled()
    expect(onStop).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('keeps the hint visible for pointerdown inside its overlay or microphone button', async () => {
    const { control } = renderControls()

    await pointerDown(control.get('[data-testid="voice-transcript-overlay"]').element)
    expect(control.find('[data-testid="voice-transcript-overlay"]').exists()).toBe(true)

    await pointerDown(control.get('[data-testid="voice-record-toggle"]').element)
    expect(control.find('[data-testid="voice-transcript-overlay"]').exists()).toBe(true)
  })

  it('shows the same error again when the user starts another attempt', async () => {
    const { control, onStart } = renderControls()
    await pointerDown()
    expect(control.find('[data-testid="voice-transcript-overlay"]').exists()).toBe(false)

    await control.get('[data-testid="voice-record-toggle"]').trigger('click')
    await flushPromises()

    expect(onStart).toHaveBeenCalledOnce()
    expect(control.get('[role="alert"]').text()).toBe('Configure STT first')
  })

  it.each(['capturing', 'transcribing', 'sending'] as const)('keeps the active %s overlay visible on outside pointerdown', async (status) => {
    const { control, onStop, onCancel } = renderControls({ status, error: null, transcript: 'Recognized words' })

    await pointerDown()

    expect(control.get('[data-testid="voice-transcript-overlay"]').attributes('data-status')).toBe(status)
    expect(control.text()).toContain('Recognized words')
    expect(onStop).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('reveals updated hint content after the previous hint was dismissed', async () => {
    const { control } = renderControls()
    await pointerDown()

    await control.setProps({ error: 'Connection unavailable' })
    expect(control.get('[role="alert"]').text()).toBe('Connection unavailable')

    await pointerDown()
    await control.setProps({ error: null, transcript: 'New transcript' })
    expect(control.get('[data-testid="voice-transcript-overlay"]').text()).toContain('New transcript')
  })

  it('removes its document pointer listener on unmount', () => {
    const addListener = vi.spyOn(document, 'addEventListener')
    const removeListener = vi.spyOn(document, 'removeEventListener')
    const { control } = renderControls()
    const registration = addListener.mock.calls.find(([event]) => event === 'pointerdown')
    expect(registration).toBeDefined()

    control.unmount()
    wrapper = undefined

    expect(removeListener).toHaveBeenCalledWith(...registration!)
  })
})
