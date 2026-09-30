<script setup lang="ts">
import PageLoading from '@/components/common/PageLoading.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { computed, onMounted, ref } from 'vue'
import { NAlert, NButton, NEmpty, NInput, NSelect, NTag, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { fetchPetdexManifest, type PetdexManifest, type PetdexPet } from '@/api/studio/petdex'
import { usePetsStore } from '@/stores/hermes/pets'
import { desktopBridge } from '@/utils/desktop-bridge'

const { t } = useI18n()
const message = useMessage()
const petsStore = usePetsStore()

const manifest = ref<PetdexManifest | null>(null)
const loading = ref(true)
const adoptingSlug = ref('')
const error = ref('')
const searchQuery = ref('')
const kindFilter = ref<string | null>(null)
const visibleLimit = ref(96)
const DESKTOP_ADOPT_SCALE = 0.58

const pets = computed(() => manifest.value?.pets ?? [])
const generatedAt = computed(() => {
  const value = manifest.value?.generatedAt
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
})

const kindOptions = computed(() => {
  const counts = new Map<string, number>()
  for (const pet of pets.value) {
    counts.set(pet.kind, (counts.get(pet.kind) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, count]) => ({
      label: `${kind} (${count})`,
      value: kind,
    }))
})

const filteredPets = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()
  return pets.value.filter((pet) => {
    if (kindFilter.value && pet.kind !== kindFilter.value) return false
    if (!query) return true
    return [pet.slug, pet.displayName, pet.kind, pet.submittedBy]
      .some(value => String(value || '').toLowerCase().includes(query))
  })
})

const visiblePets = computed(() => filteredPets.value.slice(0, visibleLimit.value))
const canShowMore = computed(() => visiblePets.value.length < filteredPets.value.length)

async function loadManifest(force = false) {
  loading.value = true
  error.value = ''
  try {
    manifest.value = await fetchPetdexManifest(force)
    visibleLimit.value = 96
  } catch (err: any) {
    error.value = err?.message || t('petdex.loadFailed')
  } finally {
    loading.value = false
  }
}

function showMore() {
  visibleLimit.value += 96
}

function assetLinks(pet: PetdexPet) {
  return [
    { label: t('petdex.spritesheet'), href: pet.spritesheetUrl },
    ...(pet.petJsonUrl ? [{ label: 'pet.json', href: pet.petJsonUrl }] : []),
    ...(pet.zipUrl ? [{ label: 'zip', href: pet.zipUrl }] : []),
  ]
}

async function adopt(pet: PetdexPet) {
  adoptingSlug.value = pet.slug
  try {
    await petsStore.adopt(pet.slug)
    const bridge = desktopBridge()
    if (bridge?.isDesktop) {
      await petsStore.savePreferences({ scale: DESKTOP_ADOPT_SCALE })
      await bridge.setPetWindowVisible?.(true).catch(() => undefined)
    }
    message.success(t('petdex.adopted', { name: pet.displayName }))
  } catch (err: any) {
    message.error(err?.message || t('petdex.adoptFailed'))
  } finally {
    adoptingSlug.value = ''
  }
}

onMounted(() => {
  void loadManifest()
  void petsStore.loadActivePet()
})
</script>

<template>
  <PageLoading :show="loading && !manifest" class="petdex-view">
    <PageHeader>
    <header class="page-header">
      <h2 class="header-title">{{ t('petdex.title') }}</h2>
      <NButton size="small" quaternary :loading="loading" @click="loadManifest(true)">
        {{ t('petdex.refresh') }}
      </NButton>
    </header>
    </PageHeader>

    <div class="petdex-content" :class="{ 'is-loading': loading && !manifest }">
      <div v-if="loading && !manifest" class="loading-state">

      </div>

      <template v-else>
        <NAlert v-if="error" type="error" class="notice">
          {{ error }}
        </NAlert>

        <div v-if="manifest" class="summary-grid">
          <div class="summary-card">
            <span>{{ t('petdex.summary.total') }}</span>
            <strong>{{ manifest.total }}</strong>
          </div>
          <div class="summary-card">
            <span>{{ t('petdex.summary.visible') }}</span>
            <strong>{{ filteredPets.length }}</strong>
          </div>
          <div class="summary-card">
            <span>{{ t('petdex.summary.kinds') }}</span>
            <strong>{{ kindOptions.length }}</strong>
          </div>
          <div class="summary-card wide">
            <span>{{ t('petdex.summary.generatedAt') }}</span>
            <strong>{{ generatedAt || '-' }}</strong>
          </div>
        </div>

        <div class="filter-row">
          <NInput v-model:value="searchQuery" :placeholder="t('petdex.searchPlaceholder')" clearable />
          <NSelect v-model:value="kindFilter" :options="kindOptions" :placeholder="t('petdex.kindFilter')" clearable />
        </div>

        <div v-if="visiblePets.length" class="pet-grid">
          <article v-for="pet in visiblePets" :key="pet.slug" class="pet-card">
            <div class="pet-preview">
              <div class="pet-frame" :style="{ backgroundImage: `url(${pet.previewUrl || pet.spritesheetUrl})` }" />
            </div>
            <div class="pet-body">
              <div class="pet-title-row">
                <h3>{{ pet.displayName }}</h3>
                <NTag size="small" round>{{ pet.kind }}</NTag>
              </div>
              <div class="pet-slug">{{ pet.slug }}</div>
              <div v-if="pet.submittedBy" class="pet-meta">
                {{ t('petdex.submittedBy', { name: pet.submittedBy }) }}
              </div>
              <div class="pet-links">
                <a v-for="link in assetLinks(pet)" :key="link.href" :href="link.href" target="_blank" rel="noopener noreferrer">
                  {{ link.label }}
                </a>
              </div>
              <div class="pet-actions">
                <NButton
                  size="small"
                  type="primary"
                  block
                  :secondary="petsStore.activePet?.slug === pet.slug"
                  :loading="adoptingSlug === pet.slug"
                  :disabled="!!adoptingSlug"
                  @click="adopt(pet)"
                >
                  {{ petsStore.activePet?.slug === pet.slug ? t('petdex.active') : t('petdex.adopt') }}
                </NButton>
              </div>
            </div>
          </article>
        </div>

        <NEmpty v-else :description="t('petdex.empty')" />

        <div v-if="canShowMore" class="load-more">
          <NButton :disabled="loading" @click="showMore">
            {{ t('petdex.showMore', { count: Math.min(96, filteredPets.length - visiblePets.length) }) }}
          </NButton>
        </div>
      </template>
    </div>
  </PageLoading>
</template>

<style scoped lang="scss">
.petdex-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
  color: var(--text-primary);
}

.petdex-content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 20px 24px 28px;
}

.loading-state {
  min-height: 320px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.notice {
  margin-bottom: 16px;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.summary-card {
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-secondary);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;

  span {
    color: var(--text-secondary);
    font-size: 12px;
  }

  strong {
    font-size: 20px;
    font-weight: 650;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}

.filter-row {
  display: grid;
  grid-template-columns: minmax(240px, 1fr) 220px;
  gap: 12px;
  margin-bottom: 18px;
}

.pet-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 14px;
}

.pet-card {
  min-width: 0;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-secondary);
  overflow: hidden;
}

.pet-preview {
  height: 132px;
  display: flex;
  align-items: center;
  justify-content: center;
  background:
    linear-gradient(45deg, rgba(127, 127, 127, 0.08) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(127, 127, 127, 0.08) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(127, 127, 127, 0.08) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(127, 127, 127, 0.08) 75%);
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
  background-size: 16px 16px;
}

.pet-frame {
  width: 92px;
  aspect-ratio: 192 / 208;
  background-repeat: no-repeat;
  background-position: 0 0;
  background-size: 800% auto;
  image-rendering: auto;
  filter: drop-shadow(0 8px 16px rgba(0, 0, 0, 0.22));
}

.pet-body {
  padding: 12px;
}

.pet-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;

  h3 {
    margin: 0;
    min-width: 0;
    font-size: 15px;
    font-weight: 650;
    line-height: 1.25;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.pet-slug,
.pet-meta {
  margin-top: 5px;
  color: var(--text-secondary);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pet-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;

  a {
    color: var(--primary-color);
    font-size: 12px;
    text-decoration: none;

    &:hover {
      text-decoration: underline;
    }
  }
}

.pet-actions {
  margin-top: 12px;
}

.load-more {
  display: flex;
  justify-content: center;
  padding: 24px 0 4px;
}

@media (max-width: 720px) {
  .petdex-content {
    padding: 16px;
  }

  .summary-grid,
  .filter-row {
    grid-template-columns: 1fr;
  }
}
</style>
