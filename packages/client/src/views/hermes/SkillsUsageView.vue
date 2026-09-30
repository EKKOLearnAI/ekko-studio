<script setup lang="ts">
import PageLoading from '@/components/common/PageLoading.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton } from 'naive-ui'
import { useProfilesStore } from '@/stores/hermes/profiles'
import {
  fetchSkillUsageStats,
  type SkillUsageDailyRow,
  type SkillUsageRow,
  type SkillUsageStats,
} from '@/api/hermes/skills'

const { t } = useI18n()
const profilesStore = useProfilesStore()
const periodOptions = [7, 30, 90, 365]
const maxVisibleChartSkills = 6
const skillPalette = [
  '#2f6eea',
  '#f26d3d',
  '#f49a5c',
  '#9aa7ff',
  '#8f2c8f',
  '#00c2d1',
]
const otherSkillColor = '#5b6b84'

interface ChartSegment {
  key: string
  label: string
  count: number
  color: string
}

const selectedDays = ref(7)
const loading = ref(true)
const error = ref('')
const statsByPeriod = ref<Record<number, SkillUsageStats | undefined>>({})
let requestSeq = 0
const latestRequestByPeriod: Record<number, number> = {}

const stats = computed(() => statsByPeriod.value[selectedDays.value] ?? null)
const hasData = computed(() => (stats.value?.summary.total_skill_actions ?? 0) > 0)
const maxDailyActions = computed(() => Math.max(...(stats.value?.by_day ?? []).map(day => day.total_count), 1))
const isRefreshing = computed(() => loading.value && !!stats.value)
const hoveredDayKey = ref<string | null>(null)
const hoveredDayIndex = ref<number | null>(null)
const hoveredDay = computed(() => stats.value?.by_day.find(day => day.date === hoveredDayKey.value) ?? null)
const hoveredSegments = computed(() => hoveredDay.value ? chartSegments(hoveredDay.value) : [])
const tooltipAlignment = computed(() => {
  const dayCount = stats.value?.by_day.length ?? 0
  if (hoveredDayIndex.value === null || dayCount <= 0) return 'align-right'
  return hoveredDayIndex.value >= dayCount / 2 ? 'align-left' : 'align-right'
})
const chartSkills = computed(() => (stats.value?.top_skills ?? []).slice(0, maxVisibleChartSkills))
const chartSkillSet = computed(() => new Set(chartSkills.value.map(skill => skill.skill)))

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`
}

function formatLastUsed(timestamp: number | null): string {
  if (!timestamp) return '—'
  return new Date(timestamp * 1000).toLocaleString()
}

function dailyBarHeight(total: number): string {
  return `${Math.max(2, (total / maxDailyActions.value) * 100)}%`
}

function segmentFlex(value: number): number {
  return Math.max(value, 0)
}

function totalSkillActions(skill: Pick<SkillUsageRow, 'view_count' | 'manage_count' | 'total_count'>): number {
  return skill.total_count || skill.view_count + skill.manage_count
}

function otherSkillsLabel(): string {
  const hiddenCount = Math.max((stats.value?.top_skills.length ?? 0) - maxVisibleChartSkills, 0)
  return hiddenCount > 0 ? `${t('skillsUsage.otherSkills')} (+${hiddenCount})` : t('skillsUsage.otherSkills')
}

function colorForSkill(skillName: string): string {
  const index = chartSkills.value.findIndex(skill => skill.skill === skillName)
  return index >= 0 ? skillPalette[index % skillPalette.length] : otherSkillColor
}

function chartSegments(day: SkillUsageDailyRow): ChartSegment[] {
  const daySkills = day.skills ?? []
  const bySkill = new Map(daySkills.map(skill => [skill.skill, totalSkillActions(skill)]))
  const segments: ChartSegment[] = chartSkills.value
    .map(skill => ({
      key: skill.skill,
      label: skill.skill,
      count: bySkill.get(skill.skill) ?? 0,
      color: colorForSkill(skill.skill),
    }))
    .filter(segment => segment.count > 0)

  const otherTotal = daySkills
    .filter(skill => !chartSkillSet.value.has(skill.skill))
    .reduce((sum, skill) => sum + totalSkillActions(skill), 0)

  if (otherTotal > 0) {
    segments.push({
      key: 'other-skills',
      label: otherSkillsLabel(),
      count: otherTotal,
      color: otherSkillColor,
    })
  }

  return segments
}

function showTooltip(day: SkillUsageDailyRow, index: number) {
  hoveredDayKey.value = day.date
  hoveredDayIndex.value = index
}

function hideTooltip(day: SkillUsageDailyRow) {
  if (hoveredDayKey.value === day.date) {
    hoveredDayKey.value = null
    hoveredDayIndex.value = null
  }
}

async function loadStats(days = selectedDays.value, force = false) {
  selectedDays.value = days
  const seq = ++requestSeq
  latestRequestByPeriod[days] = seq
  loading.value = true
  if (!statsByPeriod.value[days] || force) error.value = ''

  try {
    if (!profilesStore.activeProfileName || profilesStore.profiles.length === 0) {
      await profilesStore.fetchProfiles()
    }
    const next = await fetchSkillUsageStats(days)
    if (latestRequestByPeriod[days] === seq) {
      statsByPeriod.value = {
        ...statsByPeriod.value,
        [days]: next,
      }
    }
    if (seq === requestSeq) error.value = ''
  } catch (err: any) {
    if (seq === requestSeq) error.value = err?.message || t('skillsUsage.loadFailed')
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

onMounted(() => {
  void loadStats(7)
})
</script>

<template>
  <PageLoading :show="loading && !stats" class="skills-usage-view">
    <PageHeader>
    <header class="page-header">
      <div class="header-text">
        <h2 class="header-title">{{ t('skillsUsage.title') }}</h2>
      </div>
      <div class="skills-usage-toolbar">
        <div class="period-selector" role="group" :aria-label="t('skillsUsage.periodSelector')">
          <NButton
            v-for="days in periodOptions"
            :key="days"
            size="small"
            :secondary="selectedDays === days"
            :quaternary="selectedDays !== days"
            :type="selectedDays === days ? 'primary' : 'default'"
            :aria-pressed="selectedDays === days ? 'true' : 'false'"
            @click="loadStats(days)"
          >
            {{ t('skillsUsage.periodLabel', { days }) }}
          </NButton>
        </div>
        <NButton size="small" quaternary :loading="loading" @click="loadStats(selectedDays, true)">
          {{ t('skillsUsage.refresh') }}
        </NButton>
      </div>
    </header>
    </PageHeader>

    <div class="skills-usage-content">
      <div v-if="error && !stats" class="skills-usage-state error">
        {{ error }}
      </div>
      <div v-else-if="loading && !stats" class="skills-usage-state">

      </div>
      <template v-else-if="stats">
        <div v-if="error" class="inline-error">
          {{ error }}
        </div>
        <section class="overview-grid">
          <div class="usage-panel chart-panel" :class="{ 'is-refreshing': isRefreshing }" data-testid="skills-usage-chart">
            <div class="panel-header">
              <h3>{{ t('skillsUsage.dailyTrend') }}</h3>
              <span>{{ t('skillsUsage.periodSummary', { days: stats.period_days }) }}</span>
            </div>
            <div v-if="!hasData" class="skills-usage-state compact">
              {{ t('skillsUsage.noData') }}
            </div>
            <template v-else>
              <div class="skill-bar-chart">
                <div
                  v-for="(day, index) in stats.by_day"
                  :key="day.date"
                  class="skill-bar-col"
                  tabindex="0"
                  @mouseenter="showTooltip(day, index)"
                  @focusin="showTooltip(day, index)"
                  @mouseleave="hideTooltip(day)"
                  @focusout="hideTooltip(day)"
                >
                  <div class="skill-bar-track">
                    <div class="skill-bar-fill" :style="{ height: dailyBarHeight(day.total_count) }">
                      <div
                        v-for="segment in chartSegments(day)"
                        :key="segment.key"
                        class="skill-bar-segment"
                        :data-skill="segment.key"
                        :style="{ flex: segmentFlex(segment.count), background: segment.color }"
                      />
                    </div>
                  </div>
                </div>
              </div>
              <div v-if="hoveredDay" class="floating-tooltip" :class="tooltipAlignment">
                <div class="tooltip-date">{{ hoveredDay.date }}</div>
                <div v-for="segment in hoveredSegments" :key="segment.key" class="tooltip-row">
                  <i class="tooltip-dot" :style="{ background: segment.color }" />
                  <span>{{ segment.label }}</span>
                  <strong>{{ segment.count }}</strong>
                </div>
                <div class="tooltip-row total">
                  <span>{{ t('skillsUsage.totalActions') }}</span>
                  <strong>{{ hoveredDay.total_count }}</strong>
                </div>
              </div>
              <div class="bar-dates">
                <span>{{ stats.by_day[0]?.date.slice(5) }}</span>
                <span>{{ stats.by_day[stats.by_day.length - 1]?.date.slice(5) }}</span>
              </div>
            </template>
          </div>

          <div class="summary-grid" data-testid="skills-usage-stats" :aria-label="t('skillsUsage.summary')">
            <div class="summary-card primary">
              <div class="summary-label">{{ t('skillsUsage.totalActions') }}</div>
              <div class="summary-value">{{ stats.summary.total_skill_actions }}</div>
            </div>
            <div class="summary-card">
              <div class="summary-label">{{ t('skillsUsage.loads') }}</div>
              <div class="summary-value">{{ stats.summary.total_skill_loads }}</div>
            </div>
            <div class="summary-card">
              <div class="summary-label">{{ t('skillsUsage.edits') }}</div>
              <div class="summary-value">{{ stats.summary.total_skill_edits }}</div>
            </div>
            <div class="summary-card">
              <div class="summary-label">{{ t('skillsUsage.distinctSkills') }}</div>
              <div class="summary-value">{{ stats.summary.distinct_skills_used }}</div>
            </div>
          </div>
        </section>

        <section class="usage-panel">
          <div class="panel-header">
            <h3>{{ t('skillsUsage.topSkills') }}</h3>
            <span>{{ t('skillsUsage.periodSummary', { days: stats.period_days }) }}</span>
          </div>
          <div v-if="!hasData" class="skills-usage-state compact">
            {{ t('skillsUsage.noData') }}
          </div>
          <div v-else class="skills-table" role="table" :aria-label="t('skillsUsage.topSkills')">
            <div class="skills-row table-head" role="row">
              <span role="columnheader">{{ t('skillsUsage.skill') }}</span>
              <span role="columnheader">{{ t('skillsUsage.loads') }}</span>
              <span role="columnheader">{{ t('skillsUsage.edits') }}</span>
              <span role="columnheader">{{ t('skillsUsage.share') }}</span>
              <span role="columnheader">{{ t('skillsUsage.lastUsed') }}</span>
            </div>
            <div v-for="skill in stats.top_skills" :key="skill.skill" class="skills-row" role="row">
              <span class="skill-name" role="cell">
                <i class="skill-color-dot" :style="{ background: colorForSkill(skill.skill) }" />
                {{ skill.skill }}
              </span>
              <span role="cell">{{ skill.view_count }}</span>
              <span role="cell">{{ skill.manage_count }}</span>
              <span class="share-cell" role="cell">
                <span class="share-bar"><span :style="{ width: formatPercent(skill.percentage), background: colorForSkill(skill.skill) }" /></span>
                {{ formatPercent(skill.percentage) }}
              </span>
              <span class="last-used" role="cell">{{ formatLastUsed(skill.last_used_at) }}</span>
            </div>
          </div>
        </section>
      </template>
    </div>
  </PageLoading>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.skills-usage-view {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.header-text {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.skills-usage-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.period-selector {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.skills-usage-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  max-width: 1120px;
  margin: 0 auto;
  width: 100%;
  scrollbar-width: none;
  -ms-overflow-style: none;

  &::-webkit-scrollbar {
    display: none;
  }
}

.overview-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.7fr) minmax(260px, 0.9fr);
  gap: 16px;
  margin-bottom: 16px;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.summary-card,
.usage-panel {
  background: $bg-card;
  border: 1px solid $border-color;
  border-radius: $radius-md;
}

.summary-card {
  padding: 14px;

  &.primary {
    grid-column: span 2;
  }
}

.summary-label {
  color: $text-muted;
  font-size: 12px;
}

.summary-value {
  margin-top: 6px;
  color: $text-primary;
  font-size: 24px;
  font-weight: 700;
}

.usage-panel {
  padding: 16px;
  position: relative;

  &.is-refreshing::after {
    content: '';
    position: absolute;
    top: 10px;
    right: 12px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: $accent-primary;
    box-shadow: 0 0 0 4px $accent-muted;
    animation: refresh-pulse 1s ease-in-out infinite;
  }
}

@keyframes refresh-pulse {
  0%, 100% {
    opacity: 0.45;
    transform: scale(0.8);
  }
  50% {
    opacity: 1;
    transform: scale(1);
  }
}

.inline-error {
  margin-bottom: 12px;
  color: $error;
  font-size: 12px;
}

.panel-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;

  h3 {
    margin: 0;
    font-size: 16px;
    color: $text-primary;
  }

  span {
    color: $text-muted;
    font-size: 12px;
  }
}

.skill-bar-chart {
  display: flex;
  gap: 3px;
  min-height: 180px;
  align-items: flex-end;
}

.skill-bar-col {
  flex: 1;
  min-width: 3px;
  position: relative;
  outline: none;

  &:focus-visible .skill-bar-track {
    box-shadow: 0 0 0 2px $accent-muted;
  }
}

.skill-bar-track {
  height: 180px;
  display: flex;
  align-items: flex-end;
  background: $bg-card;
  border-radius: 3px 3px 0 0;
  overflow: hidden;
}

.skill-bar-fill {
  width: 100%;
  min-height: 2px;
  display: flex;
  flex-direction: column-reverse;
  border-radius: 3px 3px 0 0;
  overflow: hidden;
  transition: height 0.2s ease;
}

.skill-bar-segment {
  min-height: 1px;
}

.floating-tooltip {
  position: absolute;
  top: 50px;
  width: min(360px, calc(100% - 32px));
  max-height: calc(100% - 70px);
  overflow-y: auto;
  background: $bg-secondary;
  color: $text-primary;
  border: 1px solid $border-color;
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.35);
  padding: 8px 10px;
  border-radius: $radius-sm;
  font-size: 11px;
  white-space: nowrap;
  z-index: 20;
  pointer-events: none;

  &.align-left {
    left: 16px;
    right: auto;
  }

  &.align-right {
    right: 16px;
    left: auto;
  }
}

.tooltip-date {
  font-weight: 600;
  margin-bottom: 6px;
}

.tooltip-row {
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
  color: $text-secondary;
  font-size: 10px;
  line-height: 1.6;

  span {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  strong {
    color: $text-primary;
    font-weight: 600;
  }

  &.total {
    grid-template-columns: minmax(0, 1fr) auto;
    margin-top: 4px;
    padding-top: 4px;
    border-top: 1px solid $border-color;
  }
}

.tooltip-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
}

.bar-dates {
  display: flex;
  justify-content: space-between;
  color: $text-muted;
  font-size: 11px;
  margin-top: 8px;
}

.skill-color-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.skills-table {
  display: grid;
  gap: 2px;
}

.skills-row {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) 80px 80px minmax(120px, 160px) minmax(160px, 1fr);
  align-items: center;
  gap: 12px;
  padding: 10px 8px;
  border-radius: 8px;
  color: $text-secondary;
  font-size: 13px;

  &:not(.table-head):hover {
    background: $bg-card-hover;
  }
}

.table-head {
  color: $text-muted;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
}

.skill-name {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: $text-primary;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.share-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.share-bar {
  width: 54px;
  height: 6px;
  background: $bg-card;
  border-radius: 999px;
  overflow: hidden;

  span {
    display: block;
    height: 100%;
    border-radius: inherit;
  }
}

.last-used {
  color: $text-muted;
}

.skills-usage-state {
  text-align: center;
  padding: 60px 0;
  color: $text-muted;
  font-size: 14px;

  &.compact {
    padding: 24px 0;
  }

  &.error {
    color: $error;
  }
}

@media (max-width: $breakpoint-mobile) {
  .page-header {
    flex-direction: column;
    align-items: stretch;
  }

  .skills-usage-toolbar {
    justify-content: flex-start;
  }

  .overview-grid {
    grid-template-columns: 1fr;
  }

  .summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .skills-row {
    grid-template-columns: minmax(140px, 1fr) repeat(3, 64px);

    span:last-child {
      display: none;
    }
  }
}
</style>
