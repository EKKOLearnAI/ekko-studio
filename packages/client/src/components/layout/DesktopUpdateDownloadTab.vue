<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDesktopUpdate } from '@/composables/useDesktopUpdate'

const { t } = useI18n()
const { state, busy, actionFailed, act } = useDesktopUpdate()
const active = computed(() => state.value?.status === 'downloading' || state.value?.status === 'cancelling')
const percent = computed(() => state.value?.percent === null || !state.value ? null : Math.floor(state.value.percent))
const statusText = computed(() => {
  const status = state.value?.status || 'idle'
  const keys = {
    idle: 'desktopUpdateDownloading',
    downloading: percent.value === 100 ? 'desktopUpdatePreparing' : 'desktopUpdateDownloading',
    preparing: 'desktopUpdatePreparing',
    cancelling: 'desktopUpdateStopping',
    cancelled: 'desktopUpdateStopped',
    downloaded: 'desktopUpdateReady',
    error: 'desktopUpdateFailed',
    installing: 'desktopUpdateInstalling',
  }
  return t(`sidebar.${keys[status]}`)
})
const speed = computed(() => {
  const bytes = state.value?.bytesPerSecond || 0
  const units = ['B', 'KB', 'MB', 'GB']
  const index = bytes > 0 ? Math.max(0, Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)) : 0
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}/s`
})
</script>

<template>
  <section v-if="state && state.status !== 'idle'" class="desktop-update-tab" :aria-label="statusText">
    <div class="desktop-update-tab__heading">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4" />
      </svg>
      <span class="desktop-update-tab__title" :title="statusText" role="status">{{ statusText }}</span>
      <span v-if="active" class="desktop-update-tab__percent">{{ percent === null ? '—' : `${percent}%` }}</span>
      <button
        v-if="state.status === 'downloading'"
        class="desktop-update-tab__stop"
        type="button"
        :disabled="busy"
        :aria-label="t('sidebar.desktopUpdateStop')"
        :title="t('sidebar.desktopUpdateStop')"
        @click="act('cancel')"
      >
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
        </svg>
      </button>
    </div>
    <div
      v-if="active"
      class="desktop-update-tab__track"
      :class="{ 'is-indeterminate': percent === null }"
      role="progressbar"
      :aria-label="statusText"
      :aria-valuemin="0"
      :aria-valuemax="100"
      :aria-valuenow="percent === null ? undefined : percent"
    >
      <div class="desktop-update-tab__fill" :style="{ width: percent === null ? '30%' : `${percent}%` }" />
    </div>
    <div class="desktop-update-tab__details">
      <span>v{{ state.version }}</span>
      <button v-if="state.status === 'cancelled' || state.status === 'error'" class="desktop-update-tab__retry" type="button" :disabled="busy" @click="act('download')">
        {{ t('sidebar.desktopUpdateRetry') }}
      </button>
      <button v-else-if="state.status === 'downloaded'" class="desktop-update-tab__retry" type="button" :disabled="busy" @click="act('install')">
        {{ t('sidebar.desktopUpdateInstall') }}
      </button>
      <span v-else-if="state.status === 'downloading' && percent !== 100" class="desktop-update-tab__speed">{{ speed }}</span>
    </div>
    <p v-if="actionFailed" class="desktop-update-tab__error" role="alert">{{ t('sidebar.desktopUpdateActionFailed') }}</p>
  </section>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.desktop-update-tab {
  display: flex;
  flex-direction: column;
  gap: 9px;
  width: 100%;
  padding: 11px 10px 10px;
  margin-bottom: 2px;
  border-radius: 7px;
  background: rgba(var(--accent-primary-rgb), 0.045);
  color: $text-primary;
  box-sizing: border-box;

  &__heading {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    line-height: 18px;

    svg {
      width: 15px;
      height: 15px;
      flex: 0 0 auto;
      color: $text-secondary;
    }
  }

  &__title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }

  &__percent {
    flex-shrink: 0;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  &__stop {
    display: grid;
    place-items: center;
    flex: 0 0 auto;
    width: 22px;
    height: 22px;
    margin: -2px -3px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: $text-secondary;
    cursor: pointer;

    &:hover {
      background: rgba(var(--accent-primary-rgb), 0.09);
      color: $text-primary;
    }
  }

  &__track {
    height: 3px;
    border-radius: 9px;
    background: rgba(var(--accent-primary-rgb), 0.11);
    overflow: hidden;
  }

  &__fill {
    height: 100%;
    border-radius: inherit;
    background: $accent-primary;
  }

  .is-indeterminate &__fill {
    animation: desktop-update-pending 1.5s ease-in-out infinite alternate;
  }

  &__details {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    color: $text-muted;
    font-size: 11px;
    line-height: 15px;
    font-variant-numeric: tabular-nums;
  }

  &__speed {
    color: $text-secondary;
  }

  &__retry {
    padding: 0;
    border: none;
    background: transparent;
    font: inherit;
    color: $text-secondary;
    cursor: pointer;

    &:hover {
      color: $text-primary;
      text-decoration: underline;
    }
  }

  &__stop:focus-visible,
  &__retry:focus-visible {
    outline: 2px solid $accent-primary;
    outline-offset: 2px;
  }

  &__stop:disabled,
  &__retry:disabled {
    opacity: 0.5;
    cursor: wait;
  }

  &__error {
    margin: 0;
    color: $error;
    font-size: 11px;
    line-height: 1.5;
  }
}

@keyframes desktop-update-pending {
  from { transform: translateX(0); }
  to { transform: translateX(230%); }
}

@media (prefers-reduced-motion: reduce) {
  .desktop-update-tab .is-indeterminate .desktop-update-tab__fill { animation: none; }
}
</style>
