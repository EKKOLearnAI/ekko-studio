<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { usePageLoadingState } from '@/composables/usePageLoading'
import { PERSON_ANIMATIONS, PERSON_AVATAR } from '@/utils/chat-agent-avatar'

const props = defineProps<{ count: number; expanded: boolean }>()
const emit = defineEmits<{ open: [] }>()
const { t, locale } = useI18n()
const pageLoading = usePageLoadingState()
// Keep the floating capsule outside content filters and clipping ancestors.
const portalTarget = document.querySelector('.app-shell') || document.body
const formattedCount = computed(() => props.count.toLocaleString(locale.value))
const reducedMotion = ref(false)
let motionQuery: MediaQueryList | undefined
function syncMotion() { reducedMotion.value = motionQuery?.matches ?? false }
onMounted(() => {
  motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  syncMotion()
  motionQuery.addEventListener('change', syncMotion)
})
onBeforeUnmount(() => motionQuery?.removeEventListener('change', syncMotion))
</script>

<template>
  <Teleport :to="portalTarget">
    <div class="person-task-activity" role="status" aria-live="polite" aria-atomic="true">
      <Transition name="person-task-island" appear>
        <button v-if="count > 0 && !pageLoading" type="button" class="person-task-island" data-theme-surface="card"
          :aria-label="`zhezhe · ${t('person.backgroundTasks')} · ${formattedCount}`" :aria-expanded="expanded" aria-haspopup="dialog" @click="emit('open')">
          <span class="person-task-island__avatar-slot" aria-hidden="true"><img class="person-task-island__avatar" :src="reducedMotion ? PERSON_AVATAR.src : PERSON_ANIMATIONS.searching" alt="" width="48" height="48" /></span>
          <span class="person-task-island__label" aria-hidden="true"><strong>zhezhe</strong><span>{{ t('person.backgroundTasks') }}</span></span>
          <span class="person-task-island__count" aria-hidden="true">{{ formattedCount }}</span>
          <svg class="person-task-island__chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
        </button>
      </Transition>
    </div>
  </Teleport>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.person-task-activity {
  position: fixed;
  z-index: 1002;
  top: calc(var(--studio-header-height, 60px) + 12px + env(safe-area-inset-top, 0px));
  left: 50%;
  width: min(280px, calc(100vw - 32px));
  transform: translateX(-50%);
  pointer-events: none;
}
.person-task-island {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  height: 60px;
  padding: 5px 18px 5px 6px;
  border: var(--border-width, 1px) solid $border-color;
  border-radius: 999px;
  background: $bg-card;
  color: $text-primary;
  box-shadow: 0 5px 18px rgba(var(--text-primary-rgb), .08);
  cursor: pointer;
  pointer-events: auto;
  -webkit-app-region: no-drag;
  font: inherit;
  text-align: start;
  -webkit-tap-highlight-color: transparent;
}
.person-task-island:hover { border-color: $accent-primary; }
.person-task-island:focus-visible { outline: 2px solid $accent-primary; outline-offset: 3px; }
.person-task-island__avatar-slot { width: 48px; height: 48px; flex-shrink: 0; }
.person-task-island__avatar { position: absolute; inset-inline-start: 7px; top: 50%; transform: translateY(-50%); object-fit: contain; border-radius: 50%; }
.person-task-island__label { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 2px; }
.person-task-island__label strong { font-size: 14px; font-weight: 600; letter-spacing: .2px; }
.person-task-island__label > span { color: $text-secondary; font-size: 11px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.person-task-island__count { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; color: $accent-primary; }
.person-task-island__chevron { flex-shrink: 0; color: $text-muted; }
.person-task-island-enter-active { transition: clip-path 460ms cubic-bezier(.22, 1, .36, 1), transform 460ms cubic-bezier(.22, 1, .36, 1), opacity 180ms ease; }
.person-task-island-leave-active { transition: clip-path 240ms ease-in, transform 240ms ease-in, opacity 180ms ease-in; }
.person-task-island-enter-from, .person-task-island-leave-to { clip-path: inset(0 calc(50% - 24px) round 999px); transform: translateY(-5px); opacity: 0; }
.person-task-island-enter-to, .person-task-island-leave-from { clip-path: inset(0 0 round 999px); transform: translateY(0); opacity: 1; }
.person-task-island-enter-active .person-task-island__avatar { transition: inset-inline-start 460ms cubic-bezier(.22, 1, .36, 1); }
.person-task-island-leave-active .person-task-island__avatar { transition: inset-inline-start 240ms ease-in; }
.person-task-island-enter-from .person-task-island__avatar, .person-task-island-leave-to .person-task-island__avatar { inset-inline-start: calc(50% - 24px); }
.person-task-island-enter-active :is(.person-task-island__label, .person-task-island__count, .person-task-island__chevron) { transition: opacity 180ms ease 140ms; }
.person-task-island-enter-from :is(.person-task-island__label, .person-task-island__count, .person-task-island__chevron) { opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  .person-task-island-enter-active, .person-task-island-leave-active { transition: none; }
  .person-task-island-enter-active :is(.person-task-island__avatar, .person-task-island__label, .person-task-island__count, .person-task-island__chevron), .person-task-island-leave-active .person-task-island__avatar { transition: none; }
}
</style>
