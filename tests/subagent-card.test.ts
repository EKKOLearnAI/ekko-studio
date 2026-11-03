// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const state = vi.hoisted(() => ({ stream: null as unknown }))

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock('@/stores/hermes/chat', () => ({
  useChatStore: () => ({
    activeSessionId: 'sess-1',
    getSubagentStream: (_sid: string, _id: string) => state.stream,
  }),
}))
vi.mock('@/utils/hermes/subagent-stream', () => ({
  subagentIdFromToolCall: (id?: string) => (id && id.startsWith('subagent:') ? id.slice(9) : null),
  openSubagentStream: () => true,
}))

import SubagentCard from '@/components/hermes/chat/SubagentCard.vue'

const base = {
  sessionId: 'sess-1',
  subagentId: 'abc',
  taskIndex: 0,
  taskCount: 3,
  startedAt: 1000,
  updatedAt: 70000,
  completedAt: 70000,
  durationSeconds: 68,
}

describe('SubagentCard', () => {
  it('completed 态：结果回贴显示 summary + completed 样式 + 可展开完整输出', async () => {
    state.stream = {
      ...base,
      status: 'completed',
      goal: '做空者 · 扒中国巨石 601717 估值',
      summary: '结论：能跑，但有一个单点——磁盘写满会让看门狗静默失败。',
      entries: [
        { id: '1', kind: 'tool', timestamp: 2000, toolName: 'baostock_data', text: '拉季报' },
        { id: '2', kind: 'text', timestamp: 3000, text: '中间分析过程' },
      ],
    }
    const w = mount(SubagentCard, { props: { toolCallId: 'subagent:abc' } })
    expect(w.find('.subagent-card').exists()).toBe(true)
    expect(w.classes()).toContain('completed')
    expect(w.find('.sc-result').exists()).toBe(true)
    expect(w.find('.rc-check').exists()).toBe(true)
    expect(w.text()).toContain('结论：能跑，但有一个单点')
    // 展开完整输出
    await w.find('.rc-toggle').trigger('click')
    expect(w.find('.rc-detail').exists()).toBe(true)
    expect(w.text()).toContain('baostock_data')
  })

  it('running 态：显示 mini 步骤 + taskPosition + 无结果回贴', () => {
    state.stream = {
      ...base,
      status: 'running',
      durationSeconds: undefined,
      completedAt: undefined,
      goal: '外行读者 · 检查采购方案',
      entries: [
        { id: '1', kind: 'tool', timestamp: 2000, toolName: 'read_file', text: '方案' },
        { id: '2', kind: 'text', timestamp: 3000, text: '正在通读标记' },
      ],
    }
    const w = mount(SubagentCard, { props: { toolCallId: 'subagent:abc' } })
    expect(w.classes()).toContain('running')
    expect(w.find('.sc-steps').exists()).toBe(true)
    expect(w.find('.sc-result').exists()).toBe(false)
    expect(w.text()).toContain('read_file')
    expect(w.text()).toContain('1/3')
  })

  it('failed 态：醒目红框 + 显示失败原因', () => {
    state.stream = {
      ...base,
      status: 'failed',
      goal: '运维新手 · 评估看门狗',
      summary: '进程超时被杀（exit 137，内存不足）',
      entries: [{ id: '1', kind: 'text', timestamp: 2000, text: '执行中断了' }],
    }
    const w = mount(SubagentCard, { props: { toolCallId: 'subagent:abc' } })
    expect(w.classes()).toContain('failed')
    expect(w.find('.sc-result').exists()).toBe(false)
    expect(w.find('.sc-failed-box').exists()).toBe(true)
    expect(w.find('.sc-failed-concl').exists()).toBe(true)
    expect(w.text()).toContain('进程超时被杀')
  })

  it('无 stream（未派发/未知 id）时不渲染卡片', () => {
    state.stream = null
    const w = mount(SubagentCard, { props: { toolCallId: 'subagent:zzz' } })
    expect(w.find('.subagent-card').exists()).toBe(false)
  })
})
