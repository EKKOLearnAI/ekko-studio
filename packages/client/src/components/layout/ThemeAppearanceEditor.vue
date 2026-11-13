<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { GLOBAL_RANGES, SURFACE_RANGES } from '../../../../shared/theme-appearance'
import { THEME_REGIONS, normalizeThemeAppearance, type ThemeAppearance, type ThemeRegion, type GlobalAppearance } from '@/styles/theme-appearance'
import { useTheme } from '@/composables/useTheme'

const props = defineProps<{ modelValue: ThemeAppearance }>()
const emit = defineEmits<{ preview: [value: ThemeAppearance]; save: [value: ThemeAppearance] }>()
const { t } = useI18n()
const { resolvedAppearance } = useTheme()
const scope = ref<'global' | ThemeRegion>('global')
const labels = (key: string) => t(`theme.customization.${key}`)
const current = computed<GlobalAppearance>(() => scope.value === 'global' ? props.modelValue.global : props.modelValue.regions[scope.value] || {})
const colorFields = computed(() => scope.value === 'global'
  ? ['backgroundColor', 'secondaryTextColor', 'mutedTextColor', 'borderColor', 'linkColor', 'gradientColor'] as const
  : ['backgroundColor', 'borderColor'] as const)
const ranges = computed(() => scope.value === 'global' ? GLOBAL_RANGES : SURFACE_RANGES)
const defaults: Record<string, number> = { opacity: 1, blur: 0, radius: 8, shadow: 1, gradientAngle: 135, overlayOpacity: 0, borderWidth: 1, controlHeight: 36, spacing: 1, chatWidth: 960, lineHeight: 1.6, letterSpacing: 0 }
const selects = {
  backgroundSize: ['cover', 'contain', 'auto'],
  backgroundPosition: ['center', 'top', 'bottom', 'left', 'right'],
  fontFamily: ['system', 'serif', 'mono'],
} as const

function update(key: string, value: string | number | undefined, save = false) {
  const next = normalizeThemeAppearance(props.modelValue)
  const target = scope.value === 'global' ? next.global : (next.regions[scope.value] ||= {})
  if (value === undefined) delete (target as Record<string, unknown>)[key]
  else (target as Record<string, unknown>)[key] = value
  const normalized = normalizeThemeAppearance(next)
  if (save) emit('save', normalized)
  else emit('preview', normalized)
}
function value(key: string) { return (current.value as Record<string, string | number>)[key] }
function displayValue(key: string) {
  const currentValue = value(key)
  if (currentValue === undefined) return labels('inherit')
  if (key === 'opacity' || key === 'overlayOpacity') return `${Math.round(Number(currentValue) * 100)}%`
  if (['blur', 'radius', 'borderWidth', 'controlHeight', 'chatWidth', 'letterSpacing'].includes(key)) return `${currentValue}px`
  if (key === 'gradientAngle') return `${currentValue}°`
  return currentValue
}
function inheritedValue(key: string) {
  const theme = resolvedAppearance.value
  const inherited = scope.value === 'global' ? {} : props.modelValue.global
  const colorDefaults: Record<string, string> = {
    backgroundColor: scope.value === 'global' ? theme.background : theme.regions[scope.value].backgroundColor,
    secondaryTextColor: theme.secondary, mutedTextColor: theme.muted, borderColor: theme.border,
    linkColor: theme.accent, gradientColor: theme.background,
  }
  return value(key) ?? (inherited as Record<string, unknown>)[key] ?? colorDefaults[key] ?? defaults[key]
}
function input(event: Event) { return (event.target as HTMLInputElement).value }
</script>

<template>
  <section class="theme-appearance-editor">
    <h3>{{ labels('title') }}</h3>
    <p>{{ labels('hint') }}</p>
    <label class="scope-picker">
      <span>{{ labels('scope') }}</span>
      <select v-model="scope" data-testid="theme-scope">
        <option value="global">{{ labels('global') }}</option>
        <option v-for="region in THEME_REGIONS" :key="region" :value="region">{{ labels(region) }}</option>
      </select>
    </label>
    <slot v-if="scope === 'global'" name="global" />
    <div class="appearance-grid">
      <div v-for="key in colorFields" :key="key" class="appearance-setting">
        <label :for="`theme-${scope}-${key}`">{{ labels(key) }}</label>
        <div class="appearance-controls">
          <input :id="`theme-${scope}-${key}`" :data-testid="`theme-${scope}-${key}`" type="color" :value="inheritedValue(key)"
            @input="update(key, input($event))" @change="update(key, input($event), true)" />
          <small>{{ value(key) || labels('inherit') }}</small>
          <button type="button" :disabled="value(key) === undefined" :aria-label="`${labels('reset')} ${labels(key)}`" @click="update(key, undefined, true)">{{ labels('reset') }}</button>
        </div>
      </div>
      <div v-for="(range, key) in ranges" :key="key" class="appearance-setting">
        <label :for="`theme-${scope}-${key}`">{{ labels(key) }}</label>
        <div class="appearance-controls">
          <input :id="`theme-${scope}-${key}`" :data-testid="`theme-${scope}-${key}`" type="range" :min="range[0]" :max="range[1]" :step="range[2]" :value="inheritedValue(key)"
            @input="update(key, Number(input($event)))" @change="update(key, Number(input($event)), true)" />
          <output :for="`theme-${scope}-${key}`">{{ displayValue(key) }}</output>
          <button type="button" :disabled="value(key) === undefined" :aria-label="`${labels('reset')} ${labels(key)}`" @click="update(key, undefined, true)">{{ labels('reset') }}</button>
        </div>
      </div>
      <template v-if="scope === 'global'">
        <label v-for="(options, key) in selects" :key="key" class="appearance-setting">
          <span>{{ labels(key) }}</span>
          <select :value="value(key) || ''" :data-testid="`theme-global-${key}`" @change="update(key, input($event) || undefined, true)">
            <option value="">{{ labels('inherit') }}</option>
            <option v-for="option in options" :key="option" :value="option">{{ labels(option) }}</option>
          </select>
        </label>
      </template>
    </div>
  </section>
</template>

<style scoped lang="scss">
.theme-appearance-editor { padding: calc(20px * var(--spacing-scale, 1)); border: var(--border-width, 1px) solid var(--border-color); border-radius: var(--theme-card-radius, var(--radius-lg, 8px)); background: var(--theme-card-bg, var(--bg-card)); backdrop-filter: var(--theme-card-filter, none); box-shadow: var(--theme-card-shadow, none); }
h3 { margin: 0; font-size: calc(var(--font-size-base) + 1px); }
p { color: var(--text-secondary); margin: 8px 0 16px; }
.scope-picker { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; }
.appearance-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 18px 24px; }
.appearance-setting { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.appearance-controls { display: flex; align-items: center; gap: 8px; }
input[type='range'] { flex: 1; min-width: 60px; accent-color: var(--accent-primary); }
input[type='color'] { width: 36px; height: 28px; padding: 0; border: none; background: transparent; }
select { max-width: 100%; padding: 6px 10px; background: var(--theme-input-bg, var(--bg-input)); color: var(--text-primary); border: var(--border-width, 1px) solid var(--border-color); border-radius: var(--theme-input-radius, var(--radius-sm, 6px)); font: inherit; }
small, output { min-width: 48px; color: var(--text-muted); font-size: 0.85em; }
button { margin-inline-start: auto; border: none; background: transparent; color: var(--link-color, var(--accent-primary)); font: inherit; cursor: pointer; }
button:disabled { opacity: 0.4; cursor: default; }
</style>
