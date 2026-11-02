// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { ref } from 'vue'
import PersonTaskActivity from '@/components/hermes/person/PersonTaskActivity.vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: ref('en') }) }))
vi.mock('@/composables/usePageLoading', () => ({ usePageLoadingState: () => ref(false) }))
vi.mock('@/composables/useReducedMotion', () => ({ useReducedMotion: () => ref(true) }))

enableAutoUnmount(afterEach)
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
})
afterEach(() => vi.unstubAllGlobals())

it('uses execution identity, a neutral fallback, and distinct authoritative counts', async () => {
  const task = { id: 'a', title: 'Task', status: 'open', running: true, execution_state: 'running', selection_json: '{"runtime":"hermes"}', execution_selection_json: '{"runtime":"codex"}' }
  const onOpenTask = vi.fn()
  const wrapper = mount(PersonTaskActivity, { attachTo: document.body, props: { sessionId: 's', count: 2, agentCount: 5, tasks: [task, { ...task, id: 'b', execution_selection_json: 'invalid' }] as any, flows: [], onOpenTask } })
  const counters = wrapper.findAll('.activity-counter')
  expect(counters.map(counter => counter.text())).toEqual(['5', '2'])
  await new Promise(resolve => setTimeout(resolve, 5))
  await wrapper.get('.person-task-island__toggle').trigger('click')
  expect(wrapper.get('.person-task-island__toggle').attributes('aria-expanded')).toBe('true')
  expect(wrapper.findAll('.activity-row')[0].get('img').attributes('src')).toContain('codex-openai.png')
  expect(wrapper.findAll('.activity-row')[1].find('svg').exists()).toBe(true)
  await new Promise(resolve => setTimeout(resolve, 5))
  await wrapper.findAll('.activity-row')[0].trigger('click')
  expect(wrapper.get('.person-task-island__toggle').attributes('aria-expanded')).toBe('false')
  expect(onOpenTask).toHaveBeenCalledWith(task)
})
