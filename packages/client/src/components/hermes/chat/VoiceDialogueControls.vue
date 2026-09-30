<script setup lang="ts">
import type { VoiceDialogueEvent } from '@/utils/voiceDialogueEvents'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import VoiceTranscriptOverlay, { type VoiceDialogueStatus } from './VoiceTranscriptOverlay.vue'

const props = withDefaults(defineProps<{
  status: VoiceDialogueStatus
  transcript: string
  error?: string | null
  events?: Array<Pick<VoiceDialogueEvent, 'type'>>
  debug?: boolean
  onStart: () => void | Promise<void>
  onStop: () => void | Promise<void>
  onCancel: () => void
}>(), {
  error: null,
  events: () => [],
  debug: false,
})

const activeStatuses = new Set<VoiceDialogueStatus>(['capturing', 'transcribing', 'sending'])
const { t } = useI18n()

const isActive = computed(() => activeStatuses.has(props.status))
const shouldShowOverlay = computed(() => isActive.value || Boolean(props.transcript) || Boolean(props.error))
const toggleLabel = computed(() => (isActive.value ? t('chat.voiceInput.stopCaptureAndInsert') : t('chat.voiceInput.startCapture')))

async function toggle() {
  if (isActive.value) {
    await props.onStop()
    return
  }

  await props.onStart()
}

function cancel() {
  props.onCancel()
}
</script>

<template>
  <div class="voice-dialogue-controls voice-dialogue-controls--floating-overlay" :class="{ active: isActive }">
    <VoiceTranscriptOverlay
      v-if="shouldShowOverlay"
      floating
      :status="props.status"
      :transcript="props.transcript"
      :error="props.error"
      :events="props.events"
      :debug="props.debug"
    />

    <div class="voice-dialogue-controls__actions">
      <button
        type="button"
        class="voice-dialogue-controls__toggle"
        :class="{ active: isActive }"
        data-testid="voice-record-toggle"
        :aria-label="toggleLabel"
        :aria-pressed="isActive"
        @click="toggle"
      >
        <svg
          v-if="isActive"
          class="voice-dialogue-controls__icon"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
        </svg>
        <svg
          v-else
          class="voice-dialogue-controls__icon"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
          <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
          <path d="M12 18v3" />
          <path d="M9 21h6" />
        </svg>
      </button>

      <button
        v-if="isActive"
        type="button"
        class="voice-dialogue-controls__cancel"
        data-testid="voice-record-cancel"
        :aria-label="t('chat.voiceInput.cancelCapture')"
        @click="cancel"
      >
        <svg
          class="voice-dialogue-controls__icon voice-dialogue-controls__icon--small"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.voice-dialogue-controls {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.voice-dialogue-controls--floating-overlay {
  z-index: 1300;
}

.voice-dialogue-controls__actions {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  position: relative;
  z-index: 1;
}

.voice-dialogue-controls__toggle,
.voice-dialogue-controls__cancel {
  appearance: none;
  border: 0;
  font: inherit;
  color: var(--text-muted);
  background: transparent;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease, opacity 0.15s ease;
}

.voice-dialogue-controls__toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  min-width: 30px;
  padding: 0;
  border-radius: 999px;
}

.voice-dialogue-controls__toggle:hover {
  color: var(--text-secondary);
  background: rgba(128, 128, 128, 0.12);
}

.voice-dialogue-controls__toggle:focus-visible {
  outline: 2px solid var(--accent-primary);
  outline-offset: 2px;
}

.voice-dialogue-controls__toggle.active {
  color: var(--error-color, #d03050);
  background: rgba(208, 48, 80, 0.12);
}

.voice-dialogue-controls__toggle.active:hover {
  background: rgba(208, 48, 80, 0.18);
}

.voice-dialogue-controls__icon {
  display: block;
  width: 16px;
  height: 16px;
  flex: 0 0 16px;
}

.voice-dialogue-controls__cancel {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  min-width: 28px;
  padding: 0;
  border-radius: 999px;
}

.voice-dialogue-controls__icon--small {
  width: 14px;
  height: 14px;
  flex-basis: 14px;
}

.voice-dialogue-controls__cancel:hover {
  color: var(--text-secondary);
  background: rgba(128, 128, 128, 0.12);
}
</style>
