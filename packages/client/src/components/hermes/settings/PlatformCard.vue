<script setup lang="ts">
import { ref, computed } from 'vue'
import { NTag, NAlert } from 'naive-ui'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  platformKey?: string
  name: string
  icon: string
  config: Record<string, any>
  credentials?: Record<string, any>
  exclusive?: boolean
}>()

const expanded = ref(true)
const { t } = useI18n()

const configured = computed(() => {
  const creds = props.credentials
  if (!creds) return false
  if (props.platformKey === 'matrix') {
    const extra = creds.extra || {}
    const homeserver = String(extra.homeserver || '').trim()
    const token = String(creds.token || '').trim()
    const userId = String(extra.user_id || '').trim()
    const password = String(extra.password || '').trim()
    return Boolean(homeserver && (token || (userId && password)))
  }
  const keys = ['token', 'api_key', 'app_id', 'client_id', 'secret', 'app_secret', 'client_secret', 'access_token', 'bot_id', 'account_id', 'enabled']
  // Check top-level and nested extra.*
  const targets = [creds, creds.extra].filter(Boolean)
  return targets.some(obj =>
    keys.some(key => {
      const val = (obj as Record<string, any>)[key]
      return val !== undefined && val !== null && val !== '' && val !== false
    })
  )
})
</script>

<template>
  <div class="platform-card" :class="{ configured }">
    <div class="platform-card-header" @click="expanded = !expanded">
      <div class="platform-info">
        <span class="platform-icon" v-html="icon" />
        <span class="platform-name">{{ name }}</span>
        <NTag :type="configured ? 'success' : 'default'" size="small" round>
          {{ configured ? t('common.configured') : t('common.notConfigured') }}
        </NTag>
      </div>
      <span class="expand-icon" :class="{ expanded }">&#9662;</span>
    </div>
    <div v-if="expanded" class="platform-card-body">
      <NAlert v-if="exclusive" type="warning" :show-icon="true" class="exclusive-alert">
        {{ t('platform.exclusiveTokenWarning') }}
      </NAlert>
      <slot />
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.platform-card {
  background-color: var(--theme-card-bg, $bg-card);
  border: var(--border-width, 1px) solid $border-color;
  border-radius: $radius-md;
  margin-bottom: 12px;
  overflow: hidden;

  &.configured {
    border-color: rgba(var(--success-rgb), 0.2);
  }
}

.platform-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: calc(12px * var(--spacing-scale, 1)) calc(16px * var(--spacing-scale, 1));
  cursor: pointer;
  user-select: none;

  &:hover {
    background-color: rgba(var(--text-primary-rgb), 0.03);
  }
}

.platform-info {
  display: flex;
  align-items: center;
  gap: calc(10px * var(--spacing-scale, 1));
}

.platform-icon {
  width: 18px;
  height: 18px;
  color: $text-secondary;
  flex-shrink: 0;
}

.platform-name {
  font-size: calc(var(--font-size-base, 14px) * 14 / 14);
  font-weight: 500;
  color: $text-primary;
}

.expand-icon {
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  color: $text-muted;
  transition: transform 0.2s;

  &.expanded {
    transform: rotate(0deg);
  }

  &:not(.expanded) {
    transform: rotate(-90deg);
  }
}

.platform-card-body {
  padding: 0 calc(16px * var(--spacing-scale, 1)) calc(12px * var(--spacing-scale, 1));
  border-top: var(--border-width, 1px) solid $border-light;
}

.exclusive-alert {
  margin: 12px 0 4px;
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
}
</style>
