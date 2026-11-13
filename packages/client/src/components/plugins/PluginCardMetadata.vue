<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { NTag } from 'naive-ui'
import ExternalLinkIcon from '@/components/common/ExternalLinkIcon.vue'
import { normalizePluginRepository, repositoryStars as validStars } from '@/api/studio/plugin-releases'
import type { PluginUpdateState } from '@/plugins/updates'

const props = defineProps<{
  author?: string
  repository?: string | null
  stars?: number | null
  version?: string | null
  installed?: boolean
  publishedVersion?: string | null
  updateState?: PluginUpdateState
  compact?: boolean
}>()
const { t, locale } = useI18n()
const repositoryUrl = computed(() => normalizePluginRepository(props.repository))
const repositoryName = computed(() => {
  const host = repositoryUrl.value && new URL(repositoryUrl.value).hostname
  return host === 'github.com' ? 'GitHub' : host === 'gitlab.com' ? 'GitLab' : 'Gitee'
})
const stars = computed(() => {
  const value = validStars(props.stars, repositoryUrl.value || '')
  return value === null ? '—' : new Intl.NumberFormat(locale.value).format(value)
})
const updateKeys: Record<PluginUpdateState, string> = {
  available: 'updateAvailable', current: 'updateNone', unknown: 'updateUnknown', checking: 'updateChecking', development: 'updateDevelopment', manual: 'updateManual',
  ahead: 'updateAhead', local: 'updateLocal',
}
</script>

<template>
  <div class="plugin-metadata" :class="{ compact }">
    <div class="metadata-byline">
      <div class="metadata-line author"><span class="metadata-label">{{ t('studioPlugins.author') }}</span><span class="metadata-value">{{ author?.trim() || t('studioPlugins.authorUnknown') }}</span></div>
      <div class="metadata-line repository">
        <a v-if="repositoryUrl" :href="repositoryUrl" target="_blank" rel="noopener noreferrer" :aria-label="t('studioPlugins.repository') + ' · ' + repositoryName"><span>{{ repositoryName }}</span><ExternalLinkIcon /></a>
        <span v-else class="metadata-label">{{ t('studioPlugins.repositoryUnknown') }}</span>
        <span v-if="repositoryUrl && repositoryName === 'GitHub'" class="repository-stars" :aria-label="'GitHub Stars: ' + stars" :title="stars === '—' ? t('studioPlugins.starsUnknown') : 'GitHub Stars'">
          <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z" /></svg><span>{{ stars }}</span>
        </span>
      </div>
    </div>
    <div class="metadata-details">
      <div class="metadata-line versions">
        <span class="metadata-label">{{ t(installed ? 'studioPlugins.installedVersion' : 'studioPlugins.versionLabel') }}</span><span class="version">{{ version ? 'v' + version : '—' }}</span>
        <template v-if="installed && publishedVersion && publishedVersion !== version"><span class="metadata-label">{{ t('studioPlugins.publishedVersion') }}</span><span>v{{ publishedVersion }}</span></template>
      </div>
      <div v-if="updateState" class="update-state">
        <NTag v-if="updateState === 'available'" size="small" type="info" :bordered="false">{{ t('studioPlugins.updateAvailable') }}</NTag>
        <span v-else-if="updateState">{{ t('studioPlugins.' + updateKeys[updateState]) }}</span>
      </div>
      <slot />
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.plugin-metadata { display: flex; flex-direction: column; gap: 8px; font-size: 12px; line-height: 20px; color: $text-secondary; min-width: 0; }
.metadata-byline, .metadata-details { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.compact .metadata-byline, .compact .metadata-details { flex-direction: row; align-items: center; flex-wrap: wrap; gap: 6px 16px; }
.compact .metadata-byline { color: $text-secondary; }
.compact .metadata-details { font-size: 11px; color: $text-muted; }
.metadata-line { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; min-width: 0; }
.metadata-label { color: $text-muted; }
.author { flex-wrap: nowrap; }
.author .metadata-label { flex-shrink: 0; }
.metadata-value { overflow-wrap: anywhere; }
.repository { gap: 14px; align-items: center; }
.repository a { display: inline-flex; align-items: center; gap: 4px; color: $text-secondary; text-decoration: none; }
.repository a:hover { color: $accent-primary; text-decoration: underline; text-underline-offset: 3px; }
.repository-stars { display: inline-flex; align-items: center; gap: 5px; }
.repository-stars svg { display: block; flex: none; }
.versions { font-variant-numeric: tabular-nums; }
.update-state { display: flex; align-items: center; color: $text-muted; }
</style>
