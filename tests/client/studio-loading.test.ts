// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import StudioLoading from '@/components/common/StudioLoading.vue'

function render(props: Record<string, unknown> = {}, content?: string) {
  return mount(StudioLoading, {
    props,
    slots: content ? { default: content } : {},
    global: { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en: { common: { loading: 'Loading…' } } } })] },
  })
}

afterEach(() => vi.useRealTimers())

describe('StudioLoading', () => {
  it('shows an accessible logo without creating an empty content overlay', async () => {
    const wrapper = render()
    expect(wrapper.find('.n-spin-container').exists()).toBe(false)
    expect(wrapper.get('[role="status"]').attributes('aria-label')).toBe('Loading…')
    expect(wrapper.get('.studio-loading-logo img').attributes('src')).toMatch(/\/logo\.png$/)
    expect(wrapper.find('.n-spin--rotate').exists()).toBe(false)
    await wrapper.setProps({ show: false })
    expect(wrapper.find('.studio-loading-logo').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps content and user input mounted while the loading overlay changes', async () => {
    const wrapper = render({ show: false }, '<input />')
    const input = wrapper.get('input')
    await input.setValue('Keep this draft')
    expect(wrapper.find('.studio-loading-logo').exists()).toBe(false)
    await wrapper.setProps({ show: true, description: 'Fetching files', size: 'small' })
    expect(wrapper.attributes('aria-busy')).toBe('true')
    expect(wrapper.get('[role="status"]').attributes('aria-label')).toBe('Fetching files')
    expect(wrapper.get('.studio-loading-logo').attributes('style')).toContain('24px')
    expect(wrapper.get('input').element).toBe(input.element)
    await wrapper.setProps({ show: false })
    expect(wrapper.attributes('aria-busy')).toBe('false')
    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('Keep this draft')
    wrapper.unmount()
  })

  it('preserves delayed overlays and explicit icon sizes', async () => {
    vi.useFakeTimers()
    const wrapper = render({ show: false, delay: 200, size: 18 }, '<p>Content</p>')
    await wrapper.setProps({ show: true })
    expect(wrapper.find('.studio-loading-logo').exists()).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    await nextTick()
    expect(wrapper.get('.studio-loading-logo').attributes('style')).toContain('18px')
    wrapper.unmount()
  })
})
