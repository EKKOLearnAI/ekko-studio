<script setup lang="ts">
import { ref } from 'vue'
import { NAlert, NButton, NInput, NInputNumber, NModal } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { request } from '@/api/client'

interface Rate {
  provider: string
  model: string
  input: number | null
  output: number | null
  cacheRead?: number | null
  cacheWrite?: number | null
}
const { t } = useI18n()
const show = ref(false)
const busy = ref(false)
const error = ref(false)
const rates = ref<Rate[]>([])
const fields = ['input', 'output', 'cacheRead', 'cacheWrite'] as const

async function open() {
  busy.value = true
  error.value = false
  try {
    rates.value = (await request<{ rates: Rate[] }>('/api/studio/usage/pricing')).rates
    show.value = true
  } catch {
    error.value = true
  } finally { busy.value = false }
}

async function save() {
  error.value = false
  busy.value = true
  try {
    await request('/api/studio/usage/pricing', { method: 'PUT', body: JSON.stringify({ rates: rates.value }) })
    show.value = false
  } catch {
    error.value = true
  } finally { busy.value = false }
}
</script>

<template>
  <NButton size="small" quaternary :loading="busy && !show" @click="open">{{ t('usage.pricing.title') }}</NButton>
  <span v-if="error && !show" role="alert">{{ t('usage.pricing.error') }}</span>
  <NModal v-model:show="show" preset="card" :title="t('usage.pricing.title')" class="usage-pricing" style="width: min(920px, 94vw)" :mask-closable="!busy" :closable="!busy">
    <p class="pricing-help">{{ t('usage.pricing.help') }}</p>
    <NAlert v-if="error" type="error" class="pricing-error">{{ t('usage.pricing.error') }}</NAlert>
    <div class="pricing-rows">
      <div v-for="(rate, index) in rates" :key="index" class="pricing-row">
        <label>{{ t('usage.pricing.provider') }}<NInput v-model:value="rate.provider" :disabled="busy" :input-props="{ 'aria-label': t('usage.pricing.provider') }" placeholder="global" /></label>
        <label>{{ t('usage.pricing.model') }}<NInput v-model:value="rate.model" :disabled="busy" :input-props="{ 'aria-label': t('usage.pricing.model') }" placeholder="model-id" /></label>
        <label v-for="field in fields" :key="field">{{ t(`usage.pricing.${field}`) }}<NInputNumber v-model:value="rate[field]" :disabled="busy" :input-props="{ 'aria-label': t(`usage.pricing.${field}`) }" :min="0" :max="1000000" :show-button="false" :placeholder="t('usage.costStates.unknown')" /></label>
        <NButton :disabled="busy" @click="rates.splice(index, 1)">{{ t('common.delete') }}</NButton>
      </div>
    </div>
    <template #footer>
      <div class="pricing-actions">
        <NButton :disabled="busy || rates.length >= 200" @click="rates.push({ provider: 'global', model: '', input: null, output: null })">{{ t('common.add') }}</NButton>
        <NButton type="primary" :loading="busy" @click="save">{{ t('common.save') }}</NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.pricing-help { margin: 0 0 16px; line-height: 1.6; }
.pricing-error { margin-bottom: 12px; }
.pricing-rows { max-height: 60vh; overflow: auto; }
.pricing-row { display: grid; grid-template-columns: repeat(2, minmax(110px, 1.5fr)) repeat(4, minmax(85px, 1fr)) auto; align-items: end; gap: 10px; margin-bottom: 14px; }
.pricing-row label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
.pricing-actions { display: flex; justify-content: space-between; }
@media (max-width: 800px) { .pricing-row { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
