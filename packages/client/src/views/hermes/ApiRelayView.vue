<script setup lang="ts">
import { deploymentUrl } from '@/utils/deployment-url'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NButton } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import PageLoading from '@/components/common/PageLoading.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import ApiRelayUsageCard from '@/components/hermes/ApiRelayUsageCard.vue'
import RelayCampaignBadge from '@/components/hermes/RelayCampaignBadge.vue'
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
        <span class="api-relay-watermark" aria-hidden="true">11.11</span>
        <img
          class="api-relay-logo"
          :src="deploymentUrl('/relay-logo.png')"
          width="64"
          height="64"
          alt=""
          @load="logoLoading = false"
          @error="logoLoading = false"
        >
        <div class="api-relay-intro">
          <div class="api-relay-brand">
            <RelayCampaignBadge />
            <span class="api-relay-wordmark">APIKEY.FAN</span>
          </div>
          <h3 id="api-relay-heading">{{ t('apiRelay.campaignSlogan') }}</h3>
          <p>
            <span class="api-relay-service-headline">{{ t('apiRelay.headline') }}</span>
            {{ t('apiRelay.description') }}
          </p>
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
        <a class="api-relay-action" href="https://apikey.fan/activities/double11-2026?aff=LIBAPI" target="_blank" rel="noopener noreferrer">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M15 3h6v6M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
          </svg>
          {{ t('apiRelay.viewNow') }}
        </a>
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
  position: relative;
  isolation: isolate;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: calc(24px * var(--spacing-scale, 1));
  width: 100%;
  max-width: 1180px;
  min-height: 256px;
  margin: 0 auto;
  padding: calc(32px * var(--spacing-scale, 1));
  overflow: hidden;
  border: var(--border-width, 1px) solid $border-color;
  border-radius: var(--radius-component, 22px);
  background: var(--theme-card-bg, var(--theme-card-wallpaper-bg,
    radial-gradient(ellipse at 100% 0%, #95652f 0%, transparent 58%),
    linear-gradient(110deg, #241a2d, #492a27 76%, #603c24)));
  color: $text-primary;
}

.api-relay-watermark {
  position: absolute;
  z-index: -1;
  inset-inline-end: 0;
  top: -32px;
  font-size: clamp(120px, 18vw, 240px);
  font-weight: 900;
  letter-spacing: -0.08em;
  line-height: 1;
  opacity: 0.045;
  pointer-events: none;
  user-select: none;
}

// Custom card surfaces use the shared text palette; the default campaign is artwork.
html:not(.theme-card-bg):not(.theme-has-custom-background) .api-relay-hero {
  /* theme-exception: artwork -- Cream lettering contrasts with the default dark campaign artwork. */
  color: #fff1cb;
  border-color: var(--theme-card-border, #a68149);
}

.api-relay-intro {
  min-width: 0;

  h3 {
    margin: 14px 0 0;
    font-size: clamp(21px, 2.2vw, 29px);
    font-weight: 750;
    letter-spacing: -0.025em;
    line-height: var(--line-height, 1.3);
    overflow-wrap: anywhere;
  }

  > p {
    margin: 14px 0 0;
    color: color-mix(in srgb, currentColor 86%, transparent);
    font-size: calc(var(--font-size-base, 14px) * 14 / 14);
    line-height: var(--line-height, calc(var(--font-size-base, 14px) * 22 / 14));
  }
}

.api-relay-brand {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: calc(12px * var(--spacing-scale, 1));

  .api-relay-wordmark {
    display: block;
    font-size: calc(var(--font-size-base, 14px) * 12 / 14);
    font-weight: 750;
    letter-spacing: 0.08em;
  }
}

.api-relay-service-headline { display: block; margin-bottom: 6px; font-weight: 650; }

.api-relay-logo {
  display: block;
  align-self: start;
  margin-top: 6px;
  object-fit: contain;
  border-radius: 14px;
}

.api-relay-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  min-height: 44px;
  padding: 11px 20px;
  /* theme-exception: artwork -- The campaign action uses the reference artwork's gold treatment. */
  background: linear-gradient(110deg, #ffe9a3, #edb664);
  /* theme-exception: artwork -- Dark action text maintains contrast on the gold artwork. */
  color: #49290f;
  /* theme-exception: artwork -- A pale gold edge defines the campaign action against the dark artwork. */
  border: 1px solid #ffe4a0;
  border-radius: var(--radius-component, 12px);
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
  font-weight: 750;
  line-height: 1.5;
  text-align: center;
  text-decoration: none;
  transition: filter $transition-fast;

  svg { flex-shrink: 0; }
  &:hover { filter: brightness(1.07); }
  &:focus-visible { outline: 3px solid currentColor; outline-offset: 4px; box-shadow: 0 0 0 6px var(--text-on-overlay); }
}

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
  margin-top: 16px;
  gap: calc(6px * var(--spacing-scale, 1)) calc(12px * var(--spacing-scale, 1));

  span {
    color: inherit;
    font-size: calc(var(--font-size-base, 14px) * 10 / 14);
    line-height: var(--line-height, calc(var(--font-size-base, 14px) * 14 / 14));
  }
}

@media (max-width: 1100px) {
  .api-relay-hero { grid-template-columns: auto minmax(0, 1fr); }
  .api-relay-action { grid-column: 2; justify-self: start; }
}

@media (max-width: $breakpoint-mobile) {
  .api-relay-content { padding: calc(12px * var(--spacing-scale, 1)); }
  .api-relay-hero { grid-template-columns: minmax(0, 1fr); gap: 18px; padding: calc(24px * var(--spacing-scale, 1)); }
  .api-relay-logo { width: 52px; height: 52px; margin-top: 0; }
  .api-relay-action { grid-column: 1; justify-self: stretch; }
  .api-relay-usage-grid { grid-template-columns: minmax(0, 1fr); }
}

@media (prefers-reduced-motion: reduce) {
  .api-relay-action { transition: none; }
}
</style>
