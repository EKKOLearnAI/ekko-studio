<script setup lang="ts">
import { deploymentUrl } from '@/utils/deployment-url'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import PageLoading from '@/components/common/PageLoading.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import ApiRelayUsageCard from '@/components/hermes/ApiRelayUsageCard.vue'
import { fetchApiRelayUsage, type ApiRelayAccount } from '@/api/hermes/api-relay'

const { t } = useI18n()
const logoLoading = ref(true)
const usageLoading = ref(true)
const initialized = ref(false)
const accounts = ref<ApiRelayAccount[]>([])
const loadFailed = ref(false)
const loading = computed(() => logoLoading.value || !initialized.value)
let requestController: AbortController | undefined

async function loadUsage() {
  if (requestController) return
  const controller = new AbortController()
  requestController = controller
  usageLoading.value = true
  loadFailed.value = false
  try {
    const result = await fetchApiRelayUsage(controller.signal)
    accounts.value = result.accounts
  } catch {
    if (!controller.signal.aborted) loadFailed.value = true
  } finally {
    requestController = undefined
    usageLoading.value = false
    initialized.value = true
  }
}

onMounted(() => { void loadUsage() })
onBeforeUnmount(() => { requestController?.abort() })
</script>

<template>
  <PageLoading :show="loading" initial-only class="api-relay-view">
    <PageHeader>
      <header class="page-header">
        <h2 class="header-title">{{ t('apiRelay.title') }}</h2>
      </header>
    </PageHeader>
    <div class="api-relay-content">
      <section class="api-relay-hero" data-theme-surface="card" aria-labelledby="api-relay-heading">
        <div class="api-relay-intro">
          <div class="api-relay-brand">
            <img
              class="api-relay-logo"
              :src="deploymentUrl('/relay-logo.png')"
              width="54"
              height="54"
              alt=""
              @load="logoLoading = false"
              @error="logoLoading = false"
            >
            <div>
              <span>APIKEY.FAN</span>
              <h3 id="api-relay-heading">{{ t('apiRelay.headline') }}</h3>
            </div>
          </div>
          <p>{{ t('apiRelay.description') }}</p>
          <NButton
            class="api-relay-action"
            tag="a"
            href="https://apikey.fan/register?aff=LIBAPI"
            target="_blank"
            rel="noopener noreferrer"
            size="small"
            type="primary"
          >
            {{ t('apiRelay.viewNow') }}
          </NButton>
          <div class="api-relay-features">
            <span>Claude</span>
            <span>ChatGPT</span>
            <span>Grok</span>
            <span>Gemini</span>
            <span>{{ t('apiRelay.zhipu') }}</span>
            <span>Kimi</span>
            <span>DeepSeek</span>
            <span>MiniMax</span>
            <span>{{ t('apiRelay.apiCompatible') }}</span>
          </div>
        </div>
      </section>
      <section v-if="accounts.length || loadFailed" class="api-relay-usage" aria-labelledby="api-relay-usage-heading" :aria-busy="usageLoading">
        <div class="api-relay-usage-header">
          <div>
            <h3 id="api-relay-usage-heading">{{ t('apiRelay.usageTitle') }}</h3>
            <p>{{ t('apiRelay.usageScope') }}</p>
          </div>
          <NButton size="small" secondary :loading="usageLoading" @click="loadUsage">
            {{ t('usage.refresh') }}
          </NButton>
        </div>
        <p v-if="loadFailed" class="api-relay-usage-message" role="status">{{ t('apiRelay.loadFailed') }}</p>
        <div v-else-if="accounts.length" class="api-relay-usage-grid">
          <ApiRelayUsageCard v-for="account in accounts" :key="account.id" :account="account" />
        </div>
      </section>
    </div>
  </PageLoading>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
@use '@/styles/promo-hero' as *;

.api-relay-view {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--theme-content-bg, $bg-main-surface);
}

.api-relay-content {
  flex: 1 1 auto;
  min-height: 0;
  padding: calc(20px * var(--spacing-scale, 1));
  overflow: auto;
  background: linear-gradient(180deg, rgba(var(--accent-primary-rgb), 0.025), transparent 52%);
}

.api-relay-hero {
  @include promo-hero;
  width: 100%;
  max-width: 1180px;
  margin: 0 auto;
}

.api-relay-intro {
  position: relative;
  z-index: 1;
  max-width: 600px;

  > p {
    max-width: 560px;
    margin: 18px 0 0;
    color: $text-secondary;
    font-size: calc(var(--font-size-base, 14px) * 14 / 14);
    line-height: var(--line-height, calc(var(--font-size-base, 14px) * 22 / 14));
  }
}

.api-relay-brand {
  display: flex;
  align-items: center;
  gap: calc(14px * var(--spacing-scale, 1));

  span {
    display: block;
    margin-bottom: 2px;
    color: $text-muted;
    font-size: calc(var(--font-size-base, 14px) * 10 / 14);
    font-weight: 650;
    letter-spacing: 0.09em;
    line-height: var(--line-height, calc(var(--font-size-base, 14px) * 16 / 14));
  }

  h3 {
    margin: 0;
    color: $text-primary;
    font-size: clamp(21px, 2.5vw, 28px);
    font-weight: 650;
    letter-spacing: -0.03em;
    line-height: var(--line-height, 1.2);
  }
}

.api-relay-logo {
  display: block;
  flex: 0 0 auto;
  object-fit: contain;
  border-radius: var(--radius-component, 6px);
}

.api-relay-action { margin-top: 14px; }

.api-relay-usage { width: 100%; max-width: 1180px; margin: 24px auto 0; }
.api-relay-usage-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: calc(16px * var(--spacing-scale, 1));
  margin-bottom: 16px;
  h3 { margin: 0; color: $text-primary; font-size: calc(var(--font-size-base, 14px) * 16 / 14); font-weight: 600; }
  p { margin: 6px 0 0; color: $text-muted; font-size: calc(var(--font-size-base, 14px) * 12 / 14); line-height: var(--line-height, 1.6); }
  :deep(.n-button) { flex-shrink: 0; }
}
.api-relay-usage-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: calc(16px * var(--spacing-scale, 1)); }
.api-relay-usage-message { padding: calc(20px * var(--spacing-scale, 1)); margin: 0; color: $text-secondary; background: var(--theme-card-bg, $bg-card); border: var(--border-width, 1px) solid $border-color; border-radius: var(--radius-component, 12px); font-size: calc(var(--font-size-base, 14px) * 13 / 14); }

.api-relay-features {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 18px;
  gap: calc(7px * var(--spacing-scale, 1));

  span {
    padding: calc(5px * var(--spacing-scale, 1)) calc(9px * var(--spacing-scale, 1));
    color: $text-secondary;
    background: $bg-secondary;
    border: var(--border-width, 1px) solid $border-light;
    border-radius: 999px;
    font-size: calc(var(--font-size-base, 14px) * 10 / 14);
    line-height: var(--line-height, calc(var(--font-size-base, 14px) * 14 / 14));
  }
}

@media (max-width: $breakpoint-mobile) {
  .api-relay-content { padding: calc(12px * var(--spacing-scale, 1)); }
  .api-relay-hero { padding: calc(20px * var(--spacing-scale, 1)); }
  .api-relay-usage-grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
