<template>
  <div
    v-if="visible"
    class="identity-drift-banner"
    role="alert"
    data-testid="identity-drift-banner"
  >
    <div class="identity-drift-banner__icon">
      <span aria-hidden="true">⚠</span>
    </div>
    <div class="identity-drift-banner__body">
      <div class="identity-drift-banner__title">
        {{ $t('identityDrift.title') }}
      </div>
      <div class="identity-drift-banner__summary">
        {{
          $t('identityDrift.summary', {
            recorded: appStore.updateIdentity?.identity?.version ?? '?',
            running: appStore.serverVersion ?? '?',
          })
        }}
      </div>
    </div>
    <div class="identity-drift-banner__actions">
      <button
        v-if="appStore.identityRepairAvailable"
        type="button"
        class="identity-drift-banner__btn identity-drift-banner__btn--primary"
        :disabled="appStore.identityRepairing"
        data-testid="identity-drift-repair"
        @click="onRepair"
      >
        {{ appStore.identityRepairing ? $t('identityDrift.repairing') : $t('identityDrift.repair') }}
      </button>
      <button
        type="button"
        class="identity-drift-banner__btn identity-drift-banner__btn--link"
        data-testid="identity-drift-dismiss"
        @click="onDismiss"
      >
        {{ $t('identityDrift.dismiss') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '@/stores/hermes/app'
import { useMessage } from '@/composables/useAppMessage'
import { useI18n } from 'vue-i18n'

const message = useMessage();
const appStore = useAppStore()
const { t } = useI18n()

const visible = computed(() => {
  if (appStore.identityDismissed) return false
  return appStore.identityDrift
})

async function onRepair() {
  const ok = await appStore.repairUpdateIdentity()
  if (ok) {
    message.success(t('identityDrift.repaired'), { duration: 5000 })
  } else {
    message.error(t('identityDrift.repairDeferred'), { duration: 5000 })
  }
}

function onDismiss() {
  appStore.identityDismissed = true
}
</script>

<style scoped>
.identity-drift-banner {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: 8px 12px;
  padding: 10px 12px;
  border: 1px solid var(--danger-border, var(--error));
  border-radius: 8px;
  background: var(--danger-bg, rgba(var(--error-rgb), 0.08));
  color: inherit;
  font-size: 12px;
}

.identity-drift-banner__icon {
  font-size: 16px;
  line-height: 1.2;
}

.identity-drift-banner__title {
  font-weight: 600;
  margin-bottom: 2px;
}

.identity-drift-banner__summary {
  opacity: 0.85;
  word-break: break-word;
}

.identity-drift-banner__actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-left: auto;
  flex-shrink: 0;
}

.identity-drift-banner__btn {
  cursor: pointer;
  border-radius: 6px;
  border: 1px solid transparent;
  padding: 4px 10px;
  font-size: 12px;
}

.identity-drift-banner__btn--primary {
  background: var(--danger-border, var(--error));
  color: var(--text-primary);
}

.identity-drift-banner__btn--primary:disabled {
  opacity: 0.6;
  cursor: default;
}

.identity-drift-banner__btn--link {
  background: transparent;
  border: none;
  opacity: 0.7;
}
</style>
