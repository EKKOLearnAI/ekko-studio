<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { ApiRelayAccount, ApiRelayPeriodUsage } from '@/api/hermes/api-relay'

defineProps<{ account: ApiRelayAccount }>()
const { t, locale } = useI18n()

function number(value: number | null | undefined, money = false): string {
  if (value == null) return '—'
  return new Intl.NumberFormat(locale.value, { maximumFractionDigits: money ? 4 : 0 }).format(value)
}

function spend(period: ApiRelayPeriodUsage | undefined): number | undefined {
  return period?.actual_cost ?? period?.cost
}
</script>

<template>
  <article class="relay-usage-card">
    <div class="relay-usage-heading">
      <div>
        <h3>{{ [...new Set(account.sources.map(source => source.label))].join(' · ') }}</h3>
        <p class="relay-usage-endpoint">{{ account.endpoint }}</p>
      </div>
      <span v-if="account.usage" class="relay-key-status" :class="{ inactive: !account.usage.isValid }">
        {{ t(account.usage.isValid ? 'apiRelay.keyActive' : 'apiRelay.keyInactive') }}
      </span>
    </div>
    <ul class="relay-usage-sources" :aria-label="t('apiRelay.sources')">
      <li v-for="source in account.sources" :key="`${source.profile}:${source.provider}`">
        {{ source.profile }} / {{ source.label }}
      </li>
    </ul>
    <p v-if="account.status === 'error'" class="relay-usage-error" role="status">
      {{ t(`apiRelay.errors.${account.error || 'unavailable'}`) }}
    </p>
    <template v-else-if="account.usage">
      <div class="relay-balance">
        <span>{{ t('apiRelay.remaining') }}</span>
        <strong>{{ number(account.usage.remaining, true) }} <small>{{ account.usage.unit }}</small></strong>
        <p v-if="account.usage.planName">{{ account.usage.planName }}</p>
      </div>
      <div v-if="account.usage.today || account.usage.total" class="relay-table-scroll">
        <table class="relay-usage-table">
          <thead><tr>
            <th scope="col"></th>
            <th scope="col">{{ t('apiRelay.requests') }}</th>
            <th scope="col">{{ t('usage.totalTokens') }}</th>
            <th scope="col">{{ t('apiRelay.spend') }} ({{ account.usage.unit }})</th>
          </tr></thead>
          <tbody>
            <tr v-for="period in (['today', 'total'] as const)" :key="period">
              <th scope="row">{{ t(`apiRelay.${period}`) }}</th>
              <td>{{ number(account.usage[period]?.requests) }}</td>
              <td>{{ number(account.usage[period]?.total_tokens) }}</td>
              <td>{{ number(spend(account.usage[period]), true) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="account.usage.rpm != null || account.usage.tpm != null" class="relay-usage-rates">
        RPM {{ number(account.usage.rpm) }} <span>·</span> TPM {{ number(account.usage.tpm) }}
      </p>
      <details v-if="account.usage.modelStats.length" class="relay-model-details">
        <summary>{{ t('apiRelay.modelUsage') }}</summary>
        <div class="relay-table-scroll">
          <table class="relay-usage-table">
            <thead><tr>
              <th scope="col">{{ t('apiRelay.model') }}</th>
              <th scope="col">{{ t('apiRelay.requests') }}</th>
              <th scope="col">{{ t('usage.totalTokens') }}</th>
              <th scope="col">{{ t('apiRelay.spend') }} ({{ account.usage.unit }})</th>
            </tr></thead>
            <tbody><tr v-for="(model, index) in account.usage.modelStats" :key="`${model.model}:${index}`">
              <th scope="row">{{ model.model }}</th>
              <td>{{ number(model.requests) }}</td>
              <td>{{ number(model.total_tokens) }}</td>
              <td>{{ number(spend(model), true) }}</td>
            </tr></tbody>
          </table>
        </div>
      </details>
    </template>
  </article>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.relay-usage-card {
  min-width: 0;
  padding: 20px;
  border: 1px solid $border-color;
  border-radius: 12px;
  background: $bg-card;
}

.relay-usage-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;

  > div { min-width: 0; }
  h3 { margin: 0; font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
}

.relay-usage-endpoint { margin: 6px 0 0; color: $text-muted; font-size: 11px; overflow-wrap: anywhere; }
.relay-key-status { flex-shrink: 0; color: $success; font-size: 11px; }
.relay-key-status.inactive { color: $error; }
.relay-usage-sources {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 12px 0 20px;
  padding: 0;
  list-style: none;
  li { padding: 4px 7px; border-radius: 4px; color: $text-secondary; background: $bg-secondary; font-size: 11px; overflow-wrap: anywhere; }
}
.relay-balance {
  > span { display: block; margin-bottom: 6px; color: $text-muted; font-size: 12px; }
  strong { font-size: 28px; font-weight: 600; overflow-wrap: anywhere; }
  small { color: $text-secondary; font-size: 13px; font-weight: 400; }
  p { margin: 6px 0 0; color: $text-secondary; font-size: 12px; }
}
.relay-table-scroll { min-width: 0; max-width: 100%; overflow-x: auto; }
.relay-usage-table {
  width: 100%;
  margin-top: 16px;
  border-collapse: collapse;
  font-size: 12px;
  th, td { padding: 9px 8px; text-align: end; white-space: nowrap; border-bottom: 1px solid $border-light; }
  th { color: $text-muted; font-weight: 400; }
  th:first-child { padding-inline-start: 0; text-align: start; }
  td { color: $text-primary; font-variant-numeric: tabular-nums; }
}
.relay-usage-rates { margin: 14px 0 0; color: $text-muted; font-size: 11px; span { margin: 0 8px; } }
.relay-model-details { margin-top: 16px; summary { color: $text-secondary; font-size: 12px; cursor: pointer; } }
.relay-usage-error { margin: 0; color: $text-secondary; font-size: 13px; line-height: 1.6; }
@media (max-width: $breakpoint-mobile) { .relay-usage-card { padding: 16px; } }
</style>
