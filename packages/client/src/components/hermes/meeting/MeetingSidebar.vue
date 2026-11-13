<script setup lang="ts">
// 会议模式侧栏（拆分自 MeetingView）：
//   - 展开/收起（v-model:expanded）
//   - 顶部新建会议按钮（emit create）
//   - 历史会话列表（emit select，带 id）
//   - 单条删除占位（slot item-actions：父级放 NPopconfirm 二次确认）
//   - 底部 PageSidebarFooter
//
// 数据从父级 MeetingView 传进来（sortedSessions + activeId），本组件不直接依赖 store，
// 既符合"props 只读"拆分原则，也方便 jsdom 单元测试。
//
// 样式分工：本组件 scoped 样式只画"列表项"本身的内层；
// 容器布局（.meeting-sidebar / .meeting-list / .sidebar-backdrop）和删除按钮样式
// 仍由 MeetingView 提供。

import { useI18n } from 'vue-i18n'
import PageSidebarNav from '@/components/layout/PageSidebarNav.vue'
import PageSidebarFooter from '@/components/layout/PageSidebarFooter.vue'

export interface SidebarSession {
  id: string
  title: string
  updatedAt: number
  sentencesCount: number
  hasAnalysis: boolean
}

const props = defineProps<{
  expanded: boolean
  sessions: SidebarSession[]
  activeId: string | null
}>()

const emit = defineEmits<{
  (e: 'update:expanded', value: boolean): void
  (e: 'create'): void
  (e: 'select', sessionId: string): void
}>()

const { t } = useI18n()

function close() {
  emit('update:expanded', false)
}

function onCreate() {
  emit('create')
}

function onSelect(id: string) {
  emit('select', id)
}

function formatMeta(s: SidebarSession): string {
  const date = new Date(s.updatedAt).toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
  return `${date} · ${s.sentencesCount} ${t('meeting.sentences')}`
}
</script>

<template>
  <div
    class="sidebar-backdrop"
    :class="{ active: props.expanded }"
    @click="close"
  />

  <aside class="meeting-sidebar" :class="{ collapsed: !props.expanded }">
    <div v-if="props.expanded" class="page-sidebar-top">
      <PageSidebarNav
        active="meeting"
        :primary-label="t('meeting.newMeeting')"
        @primary="onCreate"
      />
      <div class="meeting-list">
        <div
          v-if="props.sessions.length === 0"
          class="meeting-list-empty"
        >
          {{ t('meeting.noMeetings') }}
        </div>
        <button
          v-for="session in props.sessions"
          :key="session.id"
          type="button"
          class="meeting-list-item"
          :class="{ active: session.id === props.activeId }"
          @click="onSelect(session.id)"
        >
          <div class="meeting-item-icon">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
            >
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" />
              <path d="M8 12l3 3 5-5" />
            </svg>
          </div>
          <div class="meeting-item-content">
            <div class="meeting-item-title">{{ session.title }}</div>
            <div class="meeting-item-meta">
              {{ formatMeta(session) }}
              <span v-if="session.hasAnalysis" class="meeting-item-badge">AI</span>
            </div>
          </div>
          <!-- 删除动作通过 slot 注入，父级包 NPopconfirm 提供二次确认 -->
          <slot
            name="item-actions"
            :session="session"
          />
        </button>
      </div>
    </div>
    <PageSidebarFooter v-if="props.expanded" />
  </aside>
</template>

<style scoped lang="scss">
/* 列表项内层样式（颜色直接走主题变量，dark/comic 自动适配）*/
.meeting-item-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.meeting-item-meta {
  font-size: 11px;
  color: var(--text-secondary);
  margin-top: 2px;
}

.meeting-item-badge {
  display: inline-block;
  margin-left: 4px;
  padding: 0 4px;
  border-radius: 4px;
  background: var(--theme-card-bg, var(--bg-card));
  font-size: 10px;
  color: var(--accent-primary);
}
</style>