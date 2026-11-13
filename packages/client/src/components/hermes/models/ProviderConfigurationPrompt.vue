<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NModal } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { getApiKey } from '@/api/client'
import { useModelsStore } from '@/stores/hermes/models'
import { useProfilesStore } from '@/stores/hermes/profiles'

const PROMPT_Z_INDEX = 4000

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const modelsStore = useModelsStore()
const profilesStore = useProfilesStore()

const show = ref(false)
const loading = ref(false)
const dismissedProfiles = new Set<string>()
let checkSequence = 0

async function checkCurrentProfile() {
  const sequence = ++checkSequence

  if (!getApiKey() || route.name === 'login' || route.name === 'hermes.models') {
    show.value = false
    return
  }

  if (!profilesStore.activeProfileName) {
    await profilesStore.fetchProfiles()
  }

  const profile = profilesStore.activeProfileName
  if (sequence !== checkSequence || !profile) return

  if (dismissedProfiles.has(profile)) {
    show.value = false
    return
  }

  loading.value = true
  try {
    await modelsStore.fetchProviders()
    if (sequence !== checkSequence || profilesStore.activeProfileName !== profile) return
    show.value = modelsStore.providers.length === 0
  } catch {
    if (sequence === checkSequence) show.value = false
  } finally {
    if (sequence === checkSequence) loading.value = false
  }
}

function remindLater() {
  const profile = profilesStore.activeProfileName
  if (profile) dismissedProfiles.add(profile)
  show.value = false
}

function goToProviderSettings() {
  show.value = false
  void router.push({ name: 'hermes.models', query: { addProvider: '1' } })
}

watch(
  [() => route.fullPath, () => profilesStore.activeProfileName],
  () => { void checkCurrentProfile() },
  { immediate: true },
)
</script>

<template>
  <NModal
    v-model:show="show"
    preset="dialog"
    :title="t('models.noProviderPromptTitle')"
    :mask-closable="false"
    :closable="false"
    :z-index="PROMPT_Z_INDEX"
  >
    <p class="provider-warning-text">
      {{ t('models.noProviderPromptMessage', { profile: profilesStore.activeProfileName }) }}
    </p>
    <template #action>
      <NButton :disabled="loading" @click="remindLater">
        {{ t('models.noProviderPromptLater') }}
      </NButton>
      <NButton type="primary" :loading="loading" @click="goToProviderSettings">
        {{ t('models.noProviderPromptAction') }}
      </NButton>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.provider-warning-text {
  margin: 0;
  line-height: var(--line-height, 1.6);
}
</style>
