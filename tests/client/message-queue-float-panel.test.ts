// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import MessageQueueFloatPanel from '@/components/hermes/chat/MessageQueueFloatPanel.vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
const mounted: VueWrapper[] = []
const items = [{ id: 'first', text: 'First message' }, { id: 'second', text: 'Second message' }]
function render(props = {}) {
  const wrapper = mount(MessageQueueFloatPanel, { props: { items, ...props } })
  mounted.push(wrapper)
  return wrapper
}
afterEach(() => mounted.splice(0).forEach(wrapper => wrapper.unmount()))

describe('message queue removal controls', () => {
  it('preserves ordinary chat removal by default and emits only the selected id', async () => {
    const wrapper = render()
    await wrapper.findAll('.queue-remove')[1]!.trigger('click')
    expect(wrapper.emitted('remove')).toEqual([['second']])
  })

  it('hides removal when the owner does not advertise the capability', () => {
    expect(render({ canRemove: false }).findAll('.queue-remove')).toHaveLength(0)
  })

  it('disables every removal while an operation is pending', async () => {
    const wrapper = render({ removeDisabled: true })
    for (const button of wrapper.findAll('.queue-remove')) {
      expect((button.element as HTMLButtonElement).disabled).toBe(true)
      await button.trigger('click')
    }
    expect(wrapper.emitted('remove')).toBeUndefined()
    await wrapper.setProps({ removeDisabled: false })
    await wrapper.findAll('.queue-remove')[0]!.trigger('click')
    expect(wrapper.emitted('remove')).toEqual([['first']])
  })

  it('protects an inserting item while allowing other queued items to be removed', async () => {
    const wrapper = render({ canInsert: true, activeInsertId: 'first', items: [{ ...items[0], removeDisabled: true }, items[1]] })
    const removes = wrapper.findAll('.queue-remove')
    expect((removes[0]!.element as HTMLButtonElement).disabled).toBe(true)
    expect((removes[1]!.element as HTMLButtonElement).disabled).toBe(false)
    await removes[0]!.trigger('click')
    await removes[1]!.trigger('click')
    expect(wrapper.emitted('remove')).toEqual([['second']])
    for (const button of wrapper.findAll('.queue-insert')) expect((button.element as HTMLButtonElement).disabled).toBe(true)
  })
})
