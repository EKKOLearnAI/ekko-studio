<script setup lang="ts">
import { computed, ref } from 'vue'
import { NAlert, NButton, NInputNumber, NModal, NSelect } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { request } from '@/api/client'
import { fetchAvailableModelsForProfile, type AvailableModelGroup } from '@/api/hermes/system'
import { useProfilesStore } from '@/stores/hermes/profiles'

interface Rate {
  provider: string
  model: string
  input: number | null
  output: number | null
  cacheRead?: number | null
  cacheWrite?: number | null
}
const { t } = useI18n()
const profilesStore = useProfilesStore()
const show = ref(false)
const busy = ref(false)
const error = ref(false)
const catalogError = ref(false)
const providers = ref<AvailableModelGroup[]>([])
const rates = ref<Rate[]>([])
const fields = ['input', 'output', 'cacheRead', 'cacheWrite'] as const

const providerOptions = computed(() => {
  const options = new Map([['global', { label: 'global', value: 'global' }]])
  for (const group of providers.value) {
    options.set(group.provider, { label: group.label || group.provider, value: group.provider })
  }
  for (const rate of rates.value) {
    if (rate.provider && !options.has(rate.provider)) {
      options.set(rate.provider, { label: rate.provider, value: rate.provider })
    }
  }
  return [...options.values()]
})

function modelOptions(provider: string) {
  const groups = provider === 'global'
    ? providers.value
    : providers.value.filter(group => group.provider === provider)
  const models = new Set(groups.flatMap(group => [...group.models, ...(group.available_models || [])]))
  for (const rate of rates.value) {
    if (rate.provider === provider && rate.model) models.add(rate.model)
  }
  return [...models].map(model => ({ label: model, value: model }))
}

function selectProvider(rate: Rate, provider: string) {
  if (rate.provider === provider) return
  rate.provider = provider
  rate.model = ''
}

async function open() {
  busy.value = true
  error.value = false
  catalogError.value = false
  providers.value = []
  try {
    const [pricing, catalog] = await Promise.allSettled([
      request<{ rates: Rate[] }>('/api/studio/usage/pricing'),
      fetchAvailableModelsForProfile(profilesStore.activeProfileName || 'default'),
    ])
    if (pricing.status === 'rejected') throw pricing.reason
    rates.value = pricing.value.rates
    if (catalog.status === 'fulfilled') {
      providers.value = catalog.value.groups.filter(group => group.provider !== 'moa')
    } else {
      catalogError.value = true
    }
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
    <p class="pricing-help">{{ t('usage.pricing.selectionHelp') }} {{ t('usage.pricing.help') }}</p>
    <NAlert v-if="catalogError" type="warning" class="pricing-error">{{ t('usage.pricing.catalogError') }}</NAlert>
    <NAlert v-if="error" type="error" class="pricing-error">{{ t('usage.pricing.error') }}</NAlert>
    <div class="pricing-rows">
      <div v-for="(rate, index) in rates" :key="index" class="pricing-row">
        <label>
          {{ t('usage.pricing.provider') }}
          <NSelect
            :value="rate.provider"
            :options="providerOptions"
            :disabled="busy"
            :input-props="{ 'aria-label': t('usage.pricing.provider') }"
            :placeholder="t('models.chooseProvider')"
            filterable
            tag
            @update:value="value => selectProvider(rate, value)"
          />
        </label>
        <label>
          {{ t('usage.pricing.model') }}
          <NSelect
            v-model:value="rate.model"
            :options="modelOptions(rate.provider)"
            :disabled="busy"
            :input-props="{ 'aria-label': t('usage.pricing.model') }"
            :placeholder="t('models.selectModel')"
            filterable
            tag
          />
        </label>
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
.pricing-row label { display: flex; flex-direction: column; min-width: 0; gap: 6px; font-size: 12px; }
.pricing-actions { display: flex; justify-content: space-between; }
@media (max-width: 800px) { .pricing-row { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
