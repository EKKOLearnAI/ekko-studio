<script setup lang="ts">
import type { VoiceDialogueEvent } from '@/utils/voiceDialogueEvents'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

export type VoiceDialogueStatus = 'idle' | 'capturing' | 'transcribing' | 'sending' | 'error'

type VoiceTranscriptOverlayEvent = Pick<VoiceDialogueEvent, 'type'>

const props = withDefaults(defineProps<{
  status: VoiceDialogueStatus
  transcript: string
  error?: string | null
  floating?: boolean
  events?: VoiceTranscriptOverlayEvent[]
  debug?: boolean
}>(), {
  error: null,
  floating: false,
  events: () => [],
  debug: false,
})

const { t } = useI18n()
const localizedStatus = computed(() => t(`chat.voiceInput.status.${props.status}`))
const statusLabel = computed(() => t('chat.voiceInput.statusLabel', { status: localizedStatus.value }))
const transcriptLabel = computed(() => t('chat.voiceInput.transcriptLabel', { text: props.transcript }))
const errorLabel = computed(() => t('chat.voiceInput.errorLabel', { error: props.error }))
const recentEventTypes = computed(() => props.events.slice(-5).map(event => event.type))
</script>

<template>
  <div
    class="voice-transcript-overlay"
    :class="{ 'voice-transcript-overlay--floating': props.floating }"
    data-testid="voice-transcript-overlay"
    :data-status="props.status"
    role="status"
    aria-live="polite"
  >
    <p class="voice-transcript-overlay__status">
      {{ statusLabel }}
    </p>
    <p v-if="props.transcript" class="voice-transcript-overlay__transcript">
      {{ transcriptLabel }}
    </p>
    <p v-if="props.error" class="voice-transcript-overlay__error" role="alert">
      {{ errorLabel }}
    </p>
    <div v-if="props.debug && recentEventTypes.length" class="voice-transcript-overlay__debug">
      <p class="voice-transcript-overlay__debug-title">
        {{ t('chat.voiceInput.recentEvents') }}
      </p>
      <ol class="voice-transcript-overlay__debug-list">
        <li
          v-for="(eventType, index) in recentEventTypes"
          :key="`${index}:${eventType}`"
          class="voice-transcript-overlay__debug-item"
          data-testid="voice-event-debug-item"
        >
          {{ eventType }}
        </li>
      </ol>
    </div>
  </div>
</template>

<style scoped>
.voice-transcript-overlay {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 12rem;
  padding: 0.5rem 0.75rem;
  color: var(--text-primary);
  border: var(--border-width, 1px) solid rgba(var(--text-primary-rgb), 0.12);
  border-radius: 0.75rem;
  background: var(--bg-card, var(--bg-input, #ffffff));
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.14);
}

.voice-transcript-overlay--floating {
  position: absolute;
  right: 0;
  bottom: calc(100% + 0.5rem);
  z-index: 1200;
  width: min(20rem, calc(100vw - 2rem));
  max-width: 20rem;
  pointer-events: none;
  box-sizing: border-box;
}

.dark .voice-transcript-overlay {
  border-color: rgba(255, 255, 255, 0.14);
  background: var(--bg-card, #333333);
  box-shadow: 0 12px 34px rgba(0, 0, 0, 0.42);
}

.voice-transcript-overlay__status,
.voice-transcript-overlay__transcript,
.voice-transcript-overlay__error,
.voice-transcript-overlay__debug-title {
  margin: 0;
}

.voice-transcript-overlay__status {
  font-size: 0.75rem;
  opacity: 0.75;
}

.voice-transcript-overlay__error {
  color: var(--error-color, #d03050);
}

.voice-transcript-overlay__debug {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.voice-transcript-overlay__debug-title {
  font-size: 0.75rem;
  opacity: 0.75;
}

.voice-transcript-overlay__debug-list {
  margin: 0;
  padding-inline-start: 1rem;
}

@media (max-width: 640px) {
  .voice-transcript-overlay--floating {
    position: fixed;
    left: 1rem;
    right: 1rem;
    bottom: calc(env(safe-area-inset-bottom, 0px) + var(--voice-overlay-mobile-bottom-offset, 9rem));
    width: auto;
    max-width: none;
  }
}
</style>
