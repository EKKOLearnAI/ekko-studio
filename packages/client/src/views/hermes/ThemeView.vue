<script setup lang="ts">
import ThemePresetManager from '@/components/layout/ThemePresetManager.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import ThemeAppearanceEditor from '@/components/layout/ThemeAppearanceEditor.vue'
import { computed, ref } from 'vue'
import { NButton, NInputNumber, NSelect, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { MAX_THEME_BACKGROUND_BYTES } from '../../../../shared/theme-archive'
import {
  MAX_THEME_FONT_SIZE,
  MIN_THEME_FONT_SIZE,
} from '@/styles/theme-customization'
import {
  useTheme,
  type BrightnessMode,
  type ThemeStyle,
} from '@/composables/useTheme'

const SUPPORTED_BACKGROUND_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/apng',
  'image/webp',
  'image/gif',
])

const { t } = useI18n()
const message = useMessage()
const fileInput = ref<HTMLInputElement | null>(null)
const backgroundBusy = ref(false)
const {
  brightness,
  appearance,
  style,
  isDark,
  fontSize,
  textColor,
  accentColor,
  backgroundImageUrl,
  backgroundImageName,
  presetBusy,
  previewThemeSettings,
  saveThemeCustomization,
  resetCustomization,
  uploadBackground,
  removeBackground,
} = useTheme()

const brightnessOptions = computed(() => [
  { label: t('theme.modeSystem'), value: 'system' },
  { label: t('theme.modeLight'), value: 'light' },
  { label: t('theme.modeDark'), value: 'dark' },
])
const styleOptions = computed(() => [
  { label: t('theme.styleInk'), value: 'ink' },
  { label: t('theme.styleComic'), value: 'comic' },
])
const resolvedTextColor = computed(() =>
  textColor.value || (isDark.value ? '#e0e0e0' : '#1a1a1a'),
)
const resolvedAccentColor = computed(() =>
  accentColor.value || (isDark.value ? '#e0e0e0' : '#333333'),
)
const previewStyle = computed(() => ({
  backgroundImage: backgroundImageUrl.value ? `url("${backgroundImageUrl.value}")` : undefined,
}))

async function savePatch(
  patch: Parameters<typeof saveThemeCustomization>[0],
  successMessage = false,
) {
  try {
    await saveThemeCustomization(patch)
    if (successMessage) message.success(t('theme.saved'))
  } catch {
    message.error(t('theme.saveFailed'))
  }
}

function handleFontSizeChange(value: number | null) {
  if (value == null) return
  void savePatch({ fontSize: value })
}

function previewTextColor(event: Event) {
  previewThemeSettings({ textColor: (event.target as HTMLInputElement).value })
}

function saveTextColor(event: Event) {
  void savePatch({ textColor: (event.target as HTMLInputElement).value })
}

function previewAccentColor(event: Event) {
  previewThemeSettings({ accentColor: (event.target as HTMLInputElement).value })
}

function saveAccentColor(event: Event) {
  void savePatch({ accentColor: (event.target as HTMLInputElement).value })
}

function openBackgroundPicker() {
  fileInput.value?.click()
}

async function handleBackgroundFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const type = file.type.toLowerCase()
  const unknownType = !type || type === 'application/octet-stream'
  const supportedExtension = /\.(?:png|jpe?g|webp|gif|apng)$/i.test(file.name)
  if (!SUPPORTED_BACKGROUND_TYPES.has(type) && !(unknownType && supportedExtension)) {
    message.error(t('theme.backgroundTypeError'))
    return
  }
  if (file.size > MAX_THEME_BACKGROUND_BYTES) {
    message.error(t('theme.backgroundSizeError'))
    return
  }

  backgroundBusy.value = true
  try {
    await uploadBackground(file)
    message.success(t('theme.backgroundUploaded'))
  } catch {
    message.error(t('theme.backgroundUploadFailed'))
  } finally {
    backgroundBusy.value = false
  }
}

async function handleRemoveBackground() {
  backgroundBusy.value = true
  try {
    await removeBackground()
    message.success(t('theme.backgroundRemoved'))
  } catch {
    message.error(t('theme.backgroundRemoveFailed'))
  } finally {
    backgroundBusy.value = false
  }
}

async function handleReset() {
  try {
    await resetCustomization()
    message.success(t('theme.resetSuccess'))
  } catch {
    message.error(t('theme.saveFailed'))
  }
}
</script>

<template>
  <div class="theme-view">
    <PageHeader>
    <header class="page-header">
      <h2 class="header-title">{{ t('theme.title') }}</h2>
      <div class="header-actions">
        <NButton size="small" secondary :disabled="presetBusy" @click="handleReset">
          {{ t('theme.reset') }}
        </NButton>
      </div>
    </header>
    </PageHeader>

    <div class="theme-content">
      <ThemePresetManager />
      <div class="theme-editors" :inert="presetBusy">
      <section class="theme-card">
        <div class="section-heading">
          <div>
            <h3>{{ t('theme.background') }}</h3>
            <p>{{ t('theme.backgroundHint') }}</p>
          </div>
          <div class="background-actions">
            <input
              ref="fileInput"
              class="file-input"
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/apng,.png,.jpg,.jpeg,.webp,.gif,.apng"
              @change="handleBackgroundFile"
            />
            <NButton size="small" :loading="backgroundBusy" @click="openBackgroundPicker">
              {{ backgroundImageUrl ? t('theme.backgroundReplace') : t('theme.backgroundUpload') }}
            </NButton>
            <NButton
              v-if="backgroundImageUrl"
              size="small"
              secondary
              :disabled="backgroundBusy"
              @click="handleRemoveBackground"
            >
              {{ t('theme.backgroundRemove') }}
            </NButton>
          </div>
        </div>
        <div class="background-preview" :class="{ empty: !backgroundImageUrl }" :style="previewStyle">
          <span v-if="!backgroundImageUrl">{{ t('theme.backgroundEmpty') }}</span>
          <span v-else class="background-name">{{ backgroundImageName }}</span>
        </div>
        <p class="background-note">{{ t('theme.backgroundNote') }}</p>
      </section>

      <ThemeAppearanceEditor
        :model-value="appearance"
        @preview="value => previewThemeSettings({ appearance: value })"
        @save="value => savePatch({ appearance: value })"
      >
        <template #global>
          <div class="theme-global-settings">
            <div class="theme-setting">
              <div>
                <label>{{ t('theme.mode') }}</label>
                <p>{{ t('theme.modeHint') }}</p>
              </div>
              <NSelect
                :value="brightness"
                :options="brightnessOptions"
                size="small"
                class="theme-select"
                @update:value="value => savePatch({ brightness: value as BrightnessMode })"
              />
            </div>

            <div class="theme-setting">
              <div>
                <label>{{ t('theme.style') }}</label>
                <p>{{ t('theme.styleHint') }}</p>
              </div>
              <NSelect
                :value="style"
                :options="styleOptions"
                size="small"
                class="theme-select"
                @update:value="value => savePatch({ style: value as ThemeStyle })"
              />
            </div>

            <div class="theme-setting">
              <div>
                <label>{{ t('theme.fontSize') }}</label>
                <p>{{ t('theme.fontSizeHint') }}</p>
              </div>
              <NInputNumber
                :value="fontSize"
                :min="MIN_THEME_FONT_SIZE"
                :max="MAX_THEME_FONT_SIZE"
                :step="1"
                size="small"
                class="font-size-input"
                @update:value="handleFontSizeChange"
              >
                <template #suffix>px</template>
              </NInputNumber>
            </div>

            <div class="theme-setting">
              <div>
                <label>{{ t('theme.textColor') }}</label>
                <p>{{ t('theme.textColorHint') }}</p>
              </div>
              <div class="color-control">
                <input
                  type="color"
                  :value="resolvedTextColor"
                  :aria-label="t('theme.textColor')"
                  @input="previewTextColor"
                  @change="saveTextColor"
                />
                <code>{{ resolvedTextColor }}</code>
                <NButton
                  v-if="textColor"
                  size="tiny"
                  text
                  @click="savePatch({ textColor: null })"
                >
                  {{ t('common.reset') }}
                </NButton>
              </div>
            </div>

            <div class="theme-setting">
              <div>
                <label>{{ t('theme.accentColor') }}</label>
                <p>{{ t('theme.accentColorHint') }}</p>
              </div>
              <div class="color-control">
                <input
                  type="color"
                  :value="resolvedAccentColor"
                  :aria-label="t('theme.accentColor')"
                  @input="previewAccentColor"
                  @change="saveAccentColor"
                />
                <code>{{ resolvedAccentColor }}</code>
                <NButton
                  v-if="accentColor"
                  size="tiny"
                  text
                  @click="savePatch({ accentColor: null })"
                >
                  {{ t('common.reset') }}
                </NButton>
              </div>
            </div>
          </div>
        </template>
      </ThemeAppearanceEditor>

      <section class="theme-preview">
        <div class="preview-copy">
          <span class="preview-kicker">{{ t('theme.preview') }}</span>
          <h3>{{ t('theme.previewTitle') }}</h3>
          <p>{{ t('theme.previewText') }}</p>
          <button type="button">{{ t('theme.previewAction') }}</button>
        </div>
      </section>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.theme-view {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  color: $text-primary;
}

.theme-content {
  width: 100%;
  box-sizing: border-box;
  padding: calc(20px * var(--spacing-scale, 1));
  overflow-y: auto;
  display: grid;
  gap: calc(16px * var(--spacing-scale, 1));
}

.theme-editors {
  display: grid;
  gap: calc(16px * var(--spacing-scale, 1));
  min-width: 0;
}

.theme-card,
.theme-preview {
  border: var(--border-width, 1px) solid $border-color;
  border-radius: $radius-lg;
  background: var(--theme-card-bg, rgba(var(--bg-card-rgb), 0.94));
  box-shadow: var(--theme-card-shadow, 0 8px 24px rgba(0, 0, 0, 0.06));
  backdrop-filter: var(--theme-card-filter, none);
}

.theme-card {
  padding: calc(18px * var(--spacing-scale, 1));
}

.section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: calc(16px * var(--spacing-scale, 1));
  padding-bottom: calc(14px * var(--spacing-scale, 1));

  h3 {
    margin: 0;
    font-size: calc(var(--font-size-base, 14px) * 15 / 14);
    font-weight: 600;
  }

  p {
    margin-top: 3px;
    color: $text-muted;
    font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  }
}

.theme-global-settings {
  margin-bottom: calc(20px * var(--spacing-scale, 1));
}

.theme-setting {
  min-height: 60px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: calc(20px * var(--spacing-scale, 1));
  border-top: var(--border-width, 1px) solid $border-light;

  label {
    font-size: calc(var(--font-size-base, 14px) * 13 / 14);
    font-weight: 500;
  }

  p {
    margin-top: 2px;
    color: $text-muted;
    font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  }
}

.theme-select,
.font-size-input {
  width: 150px;
}

.color-control,
.background-actions {
  display: flex;
  align-items: center;
  gap: calc(10px * var(--spacing-scale, 1));
}

.color-control {
  input {
    width: 34px;
    height: 34px;
    padding: calc(2px * var(--spacing-scale, 1));
    border: var(--border-width, 1px) solid $border-color;
    border-radius: $radius-sm;
    background: var(--theme-card-bg, $bg-card);
    cursor: pointer;
  }

  code {
    width: 70px;
    color: $text-secondary;
    font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  }
}

.file-input {
  display: none;
}

.background-preview {
  position: relative;
  min-height: 220px;
  display: grid;
  place-items: center;
  overflow: hidden;
  border: var(--border-width, 1px) solid $border-color;
  border-radius: $radius-md;
  background-color: $bg-secondary;
  background-position: center;
  background-repeat: no-repeat;
  background-size: cover;
  color: $text-muted;

  &.empty {
    background-image:
      linear-gradient(45deg, rgba(var(--accent-primary-rgb), 0.05) 25%, transparent 25%),
      linear-gradient(-45deg, rgba(var(--accent-primary-rgb), 0.05) 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, rgba(var(--accent-primary-rgb), 0.05) 75%),
      linear-gradient(-45deg, transparent 75%, rgba(var(--accent-primary-rgb), 0.05) 75%);
    background-position: 0 0, 0 12px, 12px -12px, -12px 0;
    background-size: 24px 24px;
  }
}

.background-name {
  position: absolute;
  right: 10px;
  bottom: 10px;
  max-width: calc(100% - 20px);
  padding: calc(4px * var(--spacing-scale, 1)) calc(8px * var(--spacing-scale, 1));
  overflow: hidden;
  border-radius: var(--radius-component, 5px);
  background: rgba(0, 0, 0, 0.62);
  color: var(--text-on-overlay);
  font-size: calc(var(--font-size-base, 14px) * 11 / 14);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.background-note {
  margin-top: 10px;
  color: $text-muted;
  font-size: calc(var(--font-size-base, 14px) * 11 / 14);
}

.theme-preview {
  min-height: 210px;
  padding: calc(32px * var(--spacing-scale, 1));
  display: flex;
  align-items: flex-end;
  background:
    linear-gradient(135deg, rgba(var(--accent-primary-rgb), 0.14), transparent 58%),
    var(--theme-card-bg, rgba(var(--bg-card-rgb), 0.94));
}

.preview-copy {
  max-width: 560px;

  .preview-kicker {
    color: $accent-primary;
    font-size: calc(var(--font-size-base, 14px) * 11 / 14);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  h3 {
    margin: 6px 0 4px;
    font-size: calc(var(--font-size-base) + 8px);
  }

  p {
    color: $text-secondary;
    font-size: var(--font-size-base);
  }

  button {
    margin-top: 16px;
    padding: calc(8px * var(--spacing-scale, 1)) calc(14px * var(--spacing-scale, 1));
    border: none;
    border-radius: $radius-sm;
    background: $accent-primary;
    color: var(--text-on-accent);
    cursor: pointer;
  }
}

@media (max-width: $breakpoint-mobile) {
  .theme-content {
    padding: calc(12px * var(--spacing-scale, 1));
  }

  .section-heading,
  .theme-setting {
    align-items: stretch;
    flex-direction: column;
  }

  .theme-setting {
    padding: calc(12px * var(--spacing-scale, 1)) 0;
    gap: calc(8px * var(--spacing-scale, 1));
  }

  .theme-select,
  .font-size-input {
    width: 100%;
  }

  .background-actions {
    flex-wrap: wrap;
  }

  .background-preview {
    min-height: 170px;
  }
}
</style>
