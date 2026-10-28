<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NInput } from 'naive-ui'
import type { PersonMemory } from '@/api/person'
import PersonPanelIcon from './PersonPanelIcon.vue'

const props = defineProps<{ memories: PersonMemory[]; saving: boolean }>()
const emit = defineEmits<{ forget: [memory: PersonMemory] }>()
const { t } = useI18n()
const search = ref('')
const filtered = computed(() => props.memories.filter(memory => memory.content.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase())))
</script>

<template>
  <section class="person-panel">
    <header class="panel-heading"><div><h2>{{ t('person.memoryTitle') }}</h2><p>{{ t('person.memoryHint') }}</p></div></header>
    <div class="panel-toolbar">
      <span class="panel-count"><strong>{{ memories.length }}</strong>{{ t('person.savedMemories') }}</span>
      <NInput v-model:value="search" class="panel-search" clearable :placeholder="t('person.search')" :input-props="{ 'aria-label': t('person.search') }"><template #prefix><PersonPanelIcon name="search" :size="16" /></template></NInput>
    </div>
    <div v-if="filtered.length" class="panel-grid">
      <article v-for="memory in filtered" :key="memory.id" class="panel-tile memory-tile" data-theme-surface="card">
        <div class="tile-top"><span class="tile-icon"><PersonPanelIcon name="memory" /></span><span class="tile-meta">{{ t('person.savedMemory') }}</span></div>
        <p class="memory-content">{{ memory.content }}</p>
        <footer class="tile-footer"><span class="tile-meta">zhezhe · {{ t('person.memory') }}</span><NButton quaternary size="small" :disabled="saving" @click="emit('forget', memory)">{{ t('person.forget') }}</NButton></footer>
      </article>
    </div>
    <div v-else class="panel-empty"><PersonPanelIcon name="memory" :size="36" /><h3>{{ t('person.empty') }}</h3><p v-if="!search">{{ t('person.memoryEmpty') }}</p></div>
  </section>
</template>

<style scoped lang="scss">
@use './person-panels';
.memory-tile { min-height: 245px; }
.memory-content { margin: 0 0 28px; font-size: 15px; line-height: 1.85; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
