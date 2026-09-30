<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

type WindowControlAction = 'minimize' | 'toggle-maximize' | 'close'

interface HermesDesktopBridge {
  platform?: string
  getWindowState?: () => Promise<{ isMaximized: boolean }>
  windowControl?: (action: WindowControlAction) => Promise<{ isMaximized: boolean }>
  onWindowStateChange?: (callback: (state: { isMaximized: boolean }) => void) => () => void
}

type WindowWithHermesDesktop = Window & typeof globalThis & {
  hermesDesktop?: HermesDesktopBridge
}

const desktop = (window as WindowWithHermesDesktop).hermesDesktop
const props = defineProps<{
  standalone?: boolean
  flush?: boolean
  leftOffset?: number
}>()
const showWindowButtons = computed(() => desktop?.platform === 'win32' || desktop?.platform === 'linux')
const titleBarStyle = computed(() => props.standalone || props.flush ? undefined : { left: `${props.leftOffset ?? 240}px` })
const isMaximized = ref(false)
let stopWindowStateListener: (() => void) | undefined

async function refreshWindowState() {
  if (!desktop?.getWindowState) return
  try {
    const state = await desktop.getWindowState()
    isMaximized.value = !!state.isMaximized
  } catch {
    /* ignore */
  }
}

async function controlWindow(action: WindowControlAction) {
  if (!desktop?.windowControl) return
  try {
    const state = await desktop.windowControl(action)
    isMaximized.value = !!state.isMaximized
  } catch {
    /* ignore */
  }
}

onMounted(() => {
  void refreshWindowState()
  stopWindowStateListener = desktop?.onWindowStateChange?.((state) => {
    isMaximized.value = !!state.isMaximized
  })
})

onUnmounted(() => stopWindowStateListener?.())
</script>

<template>
  <div
    v-if="showWindowButtons"
    class="desktop-titlebar"
    :class="{ standalone, 'desktop-titlebar--flush': flush }"
    :style="titleBarStyle"
    @dblclick="controlWindow('toggle-maximize')"
  >
    <div v-if="standalone" class="desktop-titlebar__standalone-drag" @dblclick="controlWindow('toggle-maximize')" />
    <div v-else-if="!flush" class="desktop-titlebar__drag" />
    <div class="desktop-titlebar__controls" @dblclick.stop>
      <button class="desktop-window-btn" type="button" aria-label="Minimize" @click.stop="controlWindow('minimize')">
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2 6.5h8" />
        </svg>
      </button>
      <button class="desktop-window-btn" type="button" :aria-label="isMaximized ? 'Restore' : 'Maximize'" @click.stop="controlWindow('toggle-maximize')">
        <svg v-if="isMaximized" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M4 3.5h5v5H4z" />
          <path d="M3 7.5H2.5v-5h5V3" />
        </svg>
        <svg v-else viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 2.5h7v7h-7z" />
        </svg>
      </button>
      <button class="desktop-window-btn close" type="button" aria-label="Close" @click.stop="controlWindow('close')">
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 3l6 6M9 3L3 9" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.desktop-titlebar {
  position: absolute;
  z-index: 1001;
  top: 10px;
  right: 10px;
  height: 36px;
  display: flex;
  align-items: center;
  direction: ltr;
  border: 0;
  border-radius: 12px;
  background: $bg-main-surface;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.1);
  color: $text-primary;
  user-select: none;
  overflow: hidden;
  contain: paint;
  clip-path: inset(0 round 12px);
  -webkit-app-region: drag;

  &::after {
    content: "";
    position: absolute;
    z-index: 2;
    inset: 0;
    border: 1px solid $border-color;
    border-radius: inherit;
    pointer-events: none;
  }

  &.standalone {
    left: auto;
    top: 10px;
    width: 138px;

    .desktop-titlebar__controls {
      border-inline-start: 0;
      border-radius: inherit;
      clip-path: inset(0 round 12px);
    }
  }
}

.desktop-titlebar__drag {
  min-width: 0;
  flex: 1;
  height: 100%;
}

.desktop-titlebar__standalone-drag {
  position: fixed;
  z-index: 0;
  top: 0;
  left: 0;
  right: 138px;
  height: 46px;
  -webkit-app-region: drag;
}

.desktop-titlebar__controls {
  position: relative;
  z-index: 1;
  height: 100%;
  display: flex;
  align-items: stretch;
  overflow: hidden;
  contain: paint;
  border-inline-start: 1px solid $border-color;
  border-radius: 0 12px 12px 0;
  clip-path: inset(0 round 0 12px 12px 0);
  -webkit-app-region: no-drag;
}

.desktop-window-btn {
  position: relative;
  width: 46px;
  height: 100%;
  border: 0;
  border-radius: 0;
  padding: 0;
  display: grid;
  place-items: center;
  color: $text-secondary;
  background: transparent;
  background-clip: padding-box;
  cursor: default;
  overflow: hidden;
  isolation: isolate;
  -webkit-app-region: no-drag;

  &::before {
    content: "";
    position: absolute;
    inset: 0;
    z-index: 0;
    border-radius: inherit;
    background: transparent;
    pointer-events: none;
  }

  svg {
    position: relative;
    z-index: 1;
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
    stroke-linejoin: round;
    pointer-events: none;
  }

  &:hover {
    color: $text-primary;

    &::before {
      background: rgba(var(--text-muted-rgb), 0.14);
    }
  }

  &.close:hover {
    color: #ffffff;

    &::before {
      background: #c42b1c;
    }
  }

  &:last-child {
    border-top-right-radius: 11px;
    border-bottom-right-radius: 11px;
  }

  .standalone &:first-child {
    border-top-left-radius: 11px;
    border-bottom-left-radius: 11px;
  }
}

// Header controls share its surface; override the floating bar's decoration.
.desktop-titlebar--flush {
  background: transparent;
  // Inside the shared Header, occupy only the controls at its physical right.
  left: auto;
  width: var(--desktop-window-controls-width, 138px);
  height: var(--studio-header-height, 40px);
  top: 0;
  right: 0;
  border-radius: 0;
  box-shadow: none;
  clip-path: none;

  &::after { display: none; }

  .desktop-titlebar__controls {
    border: 0;
    border-radius: 0;
    clip-path: none;
  }

  .desktop-window-btn { border-radius: 0; }
}
</style>
