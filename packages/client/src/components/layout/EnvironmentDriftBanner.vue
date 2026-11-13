<template>
  <div
    v-if="visible"
    class="environment-drift-banner"
    role="alert"
    data-testid="environment-drift-banner"
  >
    <div class="environment-drift-banner__icon">
      <span aria-hidden="true">⚠</span>
    </div>
    <div class="environment-drift-banner__body">
      <div class="environment-drift-banner__title">
        {{ $t('environmentDrift.title') }}
      </div>
      <div class="environment-drift-banner__summary">
        {{ $t('environmentDrift.summary', { count: drift.length }) }}
      </div>
      <ul class="environment-drift-banner__drift">
        <li v-for="entry in drift" :key="gateKey(entry)">
          {{ describeEntry(entry) }}
        </li>
      </ul>
    </div>
    <div class="environment-drift-banner__actions">
      <button
        type="button"
        class="environment-drift-banner__btn environment-drift-banner__btn--primary"
        :disabled="reconciling"
        data-testid="environment-drift-reconcile"
        @click="onReconcile"
      >
        {{ reconciling ? $t('environmentDrift.reconcileQueued') : $t('environmentDrift.reconcile') }}
      </button>
      <button
        type="button"
        class="environment-drift-banner__btn environment-drift-banner__btn--link"
        data-testid="environment-drift-dismiss"
        @click="onDismiss"
      >
        {{ $t('environmentDrift.dismiss') }}
      </button>
    </div>
  </div>
  <div
    v-else-if="strategySupportsDriftCheck && environmentCheck && environmentCheck.status === 'unavailable'"
    class="environment-drift-banner environment-drift-banner--info"
    role="status"
    data-testid="environment-drift-unavailable"
  >
    {{ $t('environmentDrift.unavailable') }}
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useAppStore } from '@/stores/hermes/app'

interface DriftEntry {
  gate: 'requiredNodeRange' | 'requiredHermesAgentRange' | 'requiredSystemFiles' | 'installerScriptSha256'
  expected: string
  actual: string
  detail?: string
}

const store = useAppStore()
const reconciling = ref(false)

const environmentCheck = computed(() => store.environmentCheck)
const drift = computed<DriftEntry[]>(() => environmentCheck.value?.drift ?? [])

// Environment drift detection only applies to device-package deployments.
// source-deploy and npm-package strategies don't produce env-state.json,
// so the "unavailable" status is expected and should not be shown to users.
const strategySupportsDriftCheck = computed(() => {
  const s = store.updateStrategy
  return s === 'device-package'
})

const visible = computed(() => {
  if (store.environmentDismissed) return false
  if (!environmentCheck.value) return false
  if (environmentCheck.value.status !== 'drift_detected') return false
  if (!environmentCheck.value.reconcileSupported) return false
  return drift.value.length > 0
})

function gateKey(entry: DriftEntry): string {
  return `${entry.gate}::${entry.detail ?? ''}`
}

function describeEntry(entry: DriftEntry): string {
  const tr = (key: string, params: Record<string, unknown>) => {
    const t = (store as any).$t ? (store as any).$t(key, params) : null
    return t || ''
  }
  if (entry.gate === 'requiredNodeRange') {
    return tr('environmentDrift.gateNodeRange', { actual: entry.actual, expected: entry.expected })
  }
  if (entry.gate === 'requiredHermesAgentRange') {
    return tr('environmentDrift.gateAgentRange', { actual: entry.actual, expected: entry.expected })
  }
  if (entry.gate === 'requiredSystemFiles') {
    return tr('environmentDrift.gateSystemFile', {
      path: entry.detail ?? '',
      actual: entry.actual,
      expected: entry.expected,
    })
  }
  return tr('environmentDrift.gateInstallerScript', {})
}

async function onReconcile() {
  reconciling.value = true
  try {
    await store.triggerEnvironmentReconcile()
  } finally {
    reconciling.value = false
  }
}

function onDismiss() {
  store.dismissEnvironmentDrift()
}
</script>

<style scoped>
.environment-drift-banner {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--warning);
  background: var(--theme-card-bg, var(--theme-card-bg, var(--bg-card)));
  color: var(--warning);
  border-radius: 6px;
  margin: 8px;
  font-size: 13px;
  line-height: 1.5;
}
.environment-drift-banner--info {
  border-color: var(--border-color);
  background: var(--theme-card-bg, var(--theme-card-bg, var(--bg-card)));
  color: var(--text-primary);
}
.environment-drift-banner__icon {
  font-size: 20px;
  line-height: 1;
}
.environment-drift-banner__body {
  flex: 1;
  min-width: 0;
}
.environment-drift-banner__title {
  font-weight: 600;
  margin-bottom: 4px;
}
.environment-drift-banner__summary {
  margin-bottom: 6px;
}
.environment-drift-banner__drift {
  margin: 0;
  padding-left: 18px;
}
.environment-drift-banner__drift li {
  margin: 2px 0;
}
.environment-drift-banner__actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: stretch;
}
.environment-drift-banner__btn {
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 4px 8px;
  font-size: 13px;
}
.environment-drift-banner__btn--primary {
  background: var(--warning);
  color: var(--text-primary);
  border-radius: 4px;
}
.environment-drift-banner__btn--primary:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}
.environment-drift-banner__btn--link {
  color: var(--warning);
  text-decoration: underline;
}
</style>