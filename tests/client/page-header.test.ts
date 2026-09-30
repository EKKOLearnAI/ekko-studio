// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { h, nextTick, shallowRef } from 'vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { pageHeaderTargetKey } from '@/composables/usePageHeader'

describe('PageHeader', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('moves the same interactive header between the page and shell, then cleans up on navigation', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const target = shallowRef<HTMLElement | null>(null)
    let clicks = 0
    const wrapper = mount(PageHeader, {
      attachTo: document.body,
      global: { provide: { [pageHeaderTargetKey as symbol]: target } },
      slots: { default: () => h('header', [h('input'), h('button', { onClick: () => clicks++ }, 'Action')]) },
    })
    const input = document.querySelector('input')!
    input.value = 'Unsaved filter'
    target.value = host
    await nextTick()
    expect(host.querySelector('input')).toBe(input)
    host.querySelector('button')!.click()
    expect(clicks).toBe(1)

    target.value = null
    await nextTick()
    expect(host.children).toHaveLength(0)
    expect(document.querySelector('input')).toBe(input)
    expect(input.value).toBe('Unsaved filter')

    target.value = host
    await nextTick()
    wrapper.unmount()
    expect(host.children).toHaveLength(0)
  })

  it('keeps an embedded panel header local even when a shell target exists', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const wrapper = mount(PageHeader, {
      attachTo: document.body,
      props: { disabled: true },
      global: { provide: { [pageHeaderTargetKey as symbol]: shallowRef(host) } },
      slots: { default: '<header>Embedded</header>' },
    })
    expect(host.children).toHaveLength(0)
    expect(document.querySelector('header')?.textContent).toBe('Embedded')
    wrapper.unmount()
  })

  it('renders inline in standalone contexts without an app shell', () => {
    const wrapper = mount(PageHeader, { slots: { default: '<header>Standalone</header>' } })
    expect(wrapper.find('header').text()).toBe('Standalone')
    wrapper.unmount()
  })
})
