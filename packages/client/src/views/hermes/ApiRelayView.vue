<script setup lang="ts">
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
      <section class="api-relay-hero" aria-labelledby="api-relay-heading">
        <div class="api-relay-intro">
          <div class="api-relay-brand">
            <img
              class="api-relay-logo"
              src="/relay-logo.png"
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
      <section class="api-relay-usage" aria-labelledby="api-relay-usage-heading" :aria-busy="usageLoading">
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
        <p v-else-if="!usageLoading" class="api-relay-usage-message">{{ t('apiRelay.notConfigured') }}</p>
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
  background: $bg-main-surface;
}

.api-relay-content {
  flex: 1 1 auto;
  min-height: 0;
  padding: 20px;
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
    font-size: 14px;
    line-height: 22px;
  }
}

.api-relay-brand {
  display: flex;
  align-items: center;
  gap: 14px;

  span {
    display: block;
    margin-bottom: 2px;
    color: $text-muted;
    font-size: 10px;
    font-weight: 650;
    letter-spacing: 0.09em;
    line-height: 16px;
  }

  h3 {
    margin: 0;
    color: $text-primary;
    font-size: clamp(21px, 2.5vw, 28px);
    font-weight: 650;
    letter-spacing: -0.03em;
    line-height: 1.2;
  }
}

.api-relay-logo {
  display: block;
  flex: 0 0 auto;
  object-fit: contain;
  border-radius: 6px;
}

.api-relay-action { margin-top: 14px; }

.api-relay-usage { width: 100%; max-width: 1180px; margin: 24px auto 0; }
.api-relay-usage-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
  h3 { margin: 0; color: $text-primary; font-size: 16px; font-weight: 600; }
  p { margin: 6px 0 0; color: $text-muted; font-size: 12px; line-height: 1.6; }
  :deep(.n-button) { flex-shrink: 0; }
}
.api-relay-usage-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.api-relay-usage-message { padding: 20px; margin: 0; color: $text-secondary; background: $bg-card; border: 1px solid $border-color; border-radius: 12px; font-size: 13px; }

.api-relay-features {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 18px;
  gap: 7px;

  span {
    padding: 5px 9px;
    color: $text-secondary;
    background: $bg-secondary;
    border: 1px solid $border-light;
    border-radius: 999px;
    font-size: 10px;
    line-height: 14px;
  }
}

@media (max-width: $breakpoint-mobile) {
  .api-relay-content { padding: 12px; }
  .api-relay-hero { padding: 20px; }
  .api-relay-usage-grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
