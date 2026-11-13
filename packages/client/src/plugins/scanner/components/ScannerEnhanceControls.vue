<script setup lang="ts">
/**
 * ScannerEnhanceControls - 单页增强控件：预设 + 对比度/亮度/锐化滑杆，
 * 以及「高级调节」折叠区（去阴影强度 / 二值化程度 / 底色增白 / 去噪，
 * 按预设相关性显示）与「矫正裁剪 / 重置 / 应用到所有页」动作。
 * 纯展示组件，状态由父级持有。
 */
import { computed, ref } from 'vue'
import { NButton, NIcon, NSelect, NSlider, NTooltip } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { ENHANCE_DEFAULTS, ENHANCE_PRESET_LABEL_KEYS, ENHANCE_PRESET_ORDER, type EnhanceParams, type EnhancePreset } from '../vision/types'

const props = withDefaults(defineProps<{
  params: EnhanceParams
  /** 矫正中 loading。 */
  correcting?: boolean
  /** 是否可执行矫正（引擎可用且页面上有原图）。 */
  canCorrect?: boolean
  rotating?: boolean
  /** 「应用到所有页」进行中。 */
  applyAllLoading?: boolean
  /** 是否显示「矫正裁剪」按钮（单页应用场景保持 true；实时摄像头面板可关闭）。 */
  showCorrect?: boolean
  /** 是否显示「应用到所有页」按钮（多页扫描为 true；批改单张面板为 false）。 */
  showApplyAll?: boolean
}>(), {
  correcting: false,
  canCorrect: true,
  rotating: false,
  applyAllLoading: false,
  showCorrect: true,
  showApplyAll: true,
})

const emit = defineEmits<{
  (e: 'update:params', params: EnhanceParams): void
  (e: 'correct'): void
  (e: 'reset'): void
  (e: 'rotate-left'): void
  (e: 'rotate-right'): void
  (e: 'apply-all'): void
}>()

const { t } = useI18n()
const tt = ((key: string) => {
  const value = (t as unknown as (k: string) => unknown)(key)
  return typeof value === 'string' ? value : String(key)
}) as (key: string) => string

const presetOptions = ENHANCE_PRESET_ORDER.map(preset => ({
  label: tt(ENHANCE_PRESET_LABEL_KEYS[preset]),
  value: preset,
}))

const advancedOpen = ref(false)

/** 当前预设下各高级滑杆是否生效（与 applyEnhance 管线保持一致）。 */
const advancedVisibility = computed(() => {
  switch (props.params.preset) {
    case 'scan':
      return { shadowRemove: true, binarize: false, whiteness: true, denoise: true }
    case 'bw':
      return { shadowRemove: true, binarize: true, whiteness: true, denoise: true }
    default:
      return { shadowRemove: false, binarize: false, whiteness: false, denoise: true }
  }
})

const hasVisibleAdvanced = computed(() => Object.values(advancedVisibility.value).some(Boolean))
/** 高级区是否有非默认值（用于给折叠开关一个小圆点提示）。 */
const hasTunedAdvanced = computed(() =>
  props.params.shadowRemove !== 100
  || props.params.binarizeSensitivity !== 0
  || props.params.whiteness !== 0
  || props.params.denoise !== 0)

function patch(patch: Partial<EnhanceParams>) {
  emit('update:params', { ...props.params, ...patch })
}

function setPreset(preset: EnhancePreset) {
  // 切换预设时重置中性滑杆，避免叠加旧值
  emit('update:params', { ...ENHANCE_DEFAULTS[preset] })
}

function reset() {
  emit('reset')
}
</script>

<template>
  <div class="enhance-controls">
    <div class="enhance-row enhance-row-actions">
      <span class="enhance-label">{{ tt('scanner.enhance.label') }}</span>
      <NSelect
        :value="params.preset"
        :options="presetOptions"
        size="small"
        style="width: 156px;"
        :disabled="rotating || correcting"
        @update:value="setPreset($event as EnhancePreset)"
      />
      <NTooltip>
        <template #trigger>
          <NButton
            size="small"
            quaternary
            circle
            class="enhance-rotate-button"
            data-testid="scanner-rotate-left"
            :aria-label="tt('scanner.enhance.rotateLeft')"
            :title="tt('scanner.enhance.rotateLeft')"
            :disabled="rotating || correcting"
            @click="emit('rotate-left')"
          >
            <template #icon>
              <NIcon>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M3 12a9 9 0 1 0 3-6.7" />
                  <polyline points="3 3 3 9 9 9" />
                </svg>
              </NIcon>
            </template>
          </NButton>
        </template>
        {{ tt('scanner.enhance.rotateLeft') }}
      </NTooltip>
      <NTooltip>
        <template #trigger>
          <NButton
            size="small"
            quaternary
            circle
            class="enhance-rotate-button"
            data-testid="scanner-rotate-right"
            :aria-label="tt('scanner.enhance.rotateRight')"
            :title="tt('scanner.enhance.rotateRight')"
            :disabled="rotating || correcting"
            @click="emit('rotate-right')"
          >
            <template #icon>
              <NIcon>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M21 12a9 9 0 1 1-3-6.7" />
                  <polyline points="21 3 21 9 15 9" />
                </svg>
              </NIcon>
            </template>
          </NButton>
        </template>
        {{ tt('scanner.enhance.rotateRight') }}
      </NTooltip>
      <NTooltip v-if="showCorrect">
        <template #trigger>
          <NButton
            size="small"
            quaternary
            type="primary"
            :loading="correcting"
            :disabled="!canCorrect || correcting || rotating"
            @click="emit('correct')"
          >
            {{ tt('scanner.enhance.correct') }}
          </NButton>
        </template>
        {{ tt('scanner.enhance.correctHint') }}
      </NTooltip>
      <NButton size="small" quaternary type="error" :disabled="rotating || correcting" @click="reset">
        {{ tt('scanner.enhance.reset') }}
      </NButton>
    </div>

    <div class="enhance-row">
      <span class="enhance-label">{{ tt('scanner.enhance.contrast') }}</span>
      <NSlider
        :value="params.contrast"
        :min="0"
        :max="200"
        size="small"
        :disabled="rotating || correcting"
        class="enhance-slider"
        @update:value="patch({ contrast: $event as number })"
      />
      <span class="enhance-value">{{ params.contrast }}</span>
    </div>
    <div class="enhance-row">
      <span class="enhance-label">{{ tt('scanner.enhance.brightness') }}</span>
      <NSlider
        :value="params.brightness"
        :min="-100"
        :max="100"
        size="small"
        :disabled="rotating || correcting"
        class="enhance-slider"
        @update:value="patch({ brightness: $event as number })"
      />
      <span class="enhance-value">{{ params.brightness > 0 ? `+${params.brightness}` : params.brightness }}</span>
    </div>
    <div class="enhance-row">
      <span class="enhance-label">{{ tt('scanner.enhance.sharpen') }}</span>
      <NSlider
        :value="params.sharpen"
        :min="0"
        :max="100"
        size="small"
        :disabled="rotating || correcting"
        class="enhance-slider"
        @update:value="patch({ sharpen: $event as number })"
      />
      <span class="enhance-value">{{ params.sharpen }}</span>
    </div>

    <button
      v-if="hasVisibleAdvanced"
      type="button"
      class="enhance-advanced-toggle"
      :disabled="rotating || correcting"
      @click="advancedOpen = !advancedOpen"
    >
      <NIcon size="13" class="advanced-chevron" :class="{ open: advancedOpen }">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </NIcon>
      <span>{{ tt('scanner.enhance.advanced') }}</span>
      <span v-if="hasTunedAdvanced && !advancedOpen" class="advanced-dot" aria-hidden="true" />
    </button>

    <div v-if="hasVisibleAdvanced && advancedOpen" class="enhance-advanced" data-testid="scanner-advanced-controls">
      <div v-if="advancedVisibility.shadowRemove" class="enhance-row">
        <span class="enhance-label">{{ tt('scanner.enhance.shadowRemove') }}</span>
        <NSlider
          :value="params.shadowRemove"
          :min="0"
          :max="100"
          size="small"
          :disabled="rotating || correcting"
          class="enhance-slider"
          @update:value="patch({ shadowRemove: $event as number })"
        />
        <span class="enhance-value">{{ params.shadowRemove }}</span>
      </div>
      <div v-if="advancedVisibility.binarize" class="enhance-row">
        <span class="enhance-label">{{ tt('scanner.enhance.binarize') }}</span>
        <NSlider
          :value="params.binarizeSensitivity"
          :min="-50"
          :max="50"
          size="small"
          :disabled="rotating || correcting"
          class="enhance-slider"
          :title="tt('scanner.enhance.binarizeHint')"
          @update:value="patch({ binarizeSensitivity: $event as number })"
        />
        <span class="enhance-value">{{ params.binarizeSensitivity > 0 ? `+${params.binarizeSensitivity}` : params.binarizeSensitivity }}</span>
      </div>
      <div v-if="advancedVisibility.whiteness" class="enhance-row">
        <span class="enhance-label">{{ tt('scanner.enhance.whiteness') }}</span>
        <NSlider
          :value="params.whiteness"
          :min="0"
          :max="100"
          size="small"
          :disabled="rotating || correcting"
          class="enhance-slider"
          @update:value="patch({ whiteness: $event as number })"
        />
        <span class="enhance-value">{{ params.whiteness }}</span>
      </div>
      <div v-if="advancedVisibility.denoise" class="enhance-row">
        <span class="enhance-label">{{ tt('scanner.enhance.denoise') }}</span>
        <NSlider
          :value="params.denoise"
          :min="0"
          :max="100"
          size="small"
          :disabled="rotating || correcting"
          class="enhance-slider"
          @update:value="patch({ denoise: $event as number })"
        />
        <span class="enhance-value">{{ params.denoise }}</span>
      </div>
      <div v-if="showApplyAll" class="enhance-row enhance-row-actions">
        <NButton
          size="tiny"
          quaternary
          type="primary"
          :loading="applyAllLoading"
          :disabled="rotating || correcting"
          data-testid="scanner-apply-enhance-all"
          @click="emit('apply-all')"
        >
          {{ tt('scanner.enhance.applyAll') }}
        </NButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.enhance-controls {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--border-light, rgba(var(--text-primary-rgb), 0.3));
  border-radius: 8px;
  background: var(--theme-card-bg, var(--bg-card));
}

.enhance-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.enhance-row-actions {
  flex-wrap: wrap;
}

.enhance-label {
  font-size: 12px;
  color: var(--text-muted, var(--text-primary));
  min-width: 34px;
  flex-shrink: 0;
}

.enhance-slider {
  flex: 1;
  min-width: 120px;
}

.enhance-value {
  font-size: 11.5px;
  color: var(--text-muted, var(--text-primary));
  width: 34px;
  text-align: right;
  flex-shrink: 0;
}

.enhance-advanced-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  align-self: flex-start;
  padding: 2px 4px;
  border: none;
  background: none;
  color: var(--text-muted, var(--text-primary));
  font-size: 12px;
  cursor: pointer;
  border-radius: 4px;
}

.enhance-advanced-toggle:hover:not(:disabled) {
  color: var(--text-primary, inherit);
  background: var(--bg-hover, rgba(var(--text-primary-rgb), 0.12));
}

.enhance-advanced-toggle:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.advanced-chevron {
  transition: transform 0.15s ease;
}

.advanced-chevron.open {
  transform: rotate(90deg);
}

.advanced-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent-primary);
  margin-left: 2px;
}

.enhance-advanced {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 8px 8px 10px;
  margin: -2px 0 0 6px;
  border-left: 2px solid var(--border-light, rgba(var(--text-primary-rgb), 0.25));
}
</style>
