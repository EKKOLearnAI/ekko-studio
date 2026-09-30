<script setup lang="ts">
import { NSpin, NButton, NPopconfirm, NTooltip, useMessage } from 'naive-ui'
import { ref, onUnmounted, computed, watch } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { getApiKey, getBaseUrlValue } from "@/api/client";

import { useI18n } from "vue-i18n";
import type { ITheme } from "@xterm/xterm";

const { t } = useI18n();
const message = useMessage();

const props = defineProps<{ visible?: boolean; initialCommand?: string }>();

// ─── Terminal themes ────────────────────────────────────────────

const TERMINAL_THEMES: Record<string, { label: string; theme: ITheme }> = {
  default: {
    label: "Default",
    theme: {
      background: "#1a1a2e",
      foreground: "#e0e0e0",
      cursor: "#4cc9f0",
      cursorAccent: "#1a1a2e",
      selectionBackground: "rgba(76, 201, 240, 0.3)",
      black: "#000000", red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
      blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#abb2bf",
      brightBlack: "#5c6370", brightRed: "#e06c75", brightGreen: "#98c379",
      brightYellow: "#e5c07b", brightBlue: "#61afef", brightMagenta: "#c678dd",
      brightCyan: "#56b6c2", brightWhite: "#ffffff",
    },
  },
  "solarized-dark": {
    label: "Solarized Dark",
    theme: {
      background: "#002b36", foreground: "#839496",
      cursor: "#93a1a1", cursorAccent: "#002b36",
      selectionBackground: "rgba(147, 161, 161, 0.3)",
      black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900",
      blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
      brightBlack: "#002b36", brightRed: "#cb4b16", brightGreen: "#586e75",
      brightYellow: "#657b83", brightBlue: "#839496", brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
    },
  },
  "tokyo-night": {
    label: "Tokyo Night",
    theme: {
      background: "#1a1b26", foreground: "#a9b1d6",
      cursor: "#c0caf5", cursorAccent: "#1a1b26",
      selectionBackground: "rgba(192, 202, 245, 0.2)",
      black: "#15161e", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68",
      blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff", white: "#a9b1d6",
      brightBlack: "#414868", brightRed: "#f7768e", brightGreen: "#9ece6a",
      brightYellow: "#e0af68", brightBlue: "#7aa2f7", brightMagenta: "#bb9af7",
      brightCyan: "#7dcfff", brightWhite: "#c0caf5",
    },
  },
  "github-dark": {
    label: "GitHub Dark",
    theme: {
      background: "#0d1117", foreground: "#c9d1d9",
      cursor: "#58a6ff", cursorAccent: "#0d1117",
      selectionBackground: "rgba(88, 166, 255, 0.25)",
      black: "#484f58", red: "#ff7b72", green: "#7ee787", yellow: "#ffa657",
      blue: "#79c0ff", magenta: "#d2a8ff", cyan: "#a5d6ff", white: "#c9d1d9",
      brightBlack: "#6e7681", brightRed: "#ffa198", brightGreen: "#56d364",
      brightYellow: "#e3b341", brightBlue: "#58a6ff", brightMagenta: "#bc8cff",
      brightCyan: "#79c0ff", brightWhite: "#f0f6fc",
    },
  },
};

const STORAGE_KEY_THEME = "hermes_terminal_theme";

// ─── Types ──────────────────────────────────────────────────────

interface SessionInfo {
  id: string;
  shell: string;
  pid: number;
  title: string;
  createdAt: number;
  exited: boolean;
}

// ─── State ──────────────────────────────────────────────────────

const terminalRef = ref<HTMLDivElement | null>(null);
const sessions = ref<SessionInfo[]>([]);
const activeSessionId = ref<string | null>(null);
const selectedTheme = ref(localStorage.getItem(STORAGE_KEY_THEME) || "default");
const connectionError = ref<string | null>(null);
const isConnecting = ref(false);

let ws: WebSocket | null = null;
const termMap = new Map<string, { term: Terminal; fitAddon: FitAddon; opened: boolean }>();
let activeTerm: Terminal | null = null;
let activeFitAddon: FitAddon | null = null;
let resizeObserver: ResizeObserver | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;
let touchScrollLastY: number | null = null;
let touchScrollRemainder = 0;
const TOUCH_SCROLL_LINE_PX = 18;
const INITIAL_COMMAND_CHUNK_SIZE = 128;
const INITIAL_COMMAND_CHUNK_DELAY_MS = 8;
const initialCommandSent = ref(false);
const initialCommandTimers = new Set<ReturnType<typeof setTimeout>>();

// ─── Computed ──────────────────────────────────────────────────

const terminalBg = computed(
  () => TERMINAL_THEMES[selectedTheme.value]?.theme.background ?? "#1a1a2e",
);
const selectedThemeLabel = computed(
  () => TERMINAL_THEMES[selectedTheme.value]?.label ?? TERMINAL_THEMES.default.label,
);
const selectedThemeInitial = computed(
  () => selectedThemeLabel.value.charAt(0).toUpperCase(),
);

// ─── WebSocket ──────────────────────────────────────────────────

function formatHostForPort(hostname: string, port: number): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return `${hostname}:${port}`;
  }
  return hostname.includes(":") ? `[${hostname}]:${port}` : `${hostname}:${port}`;
}

function buildWsUrl(): string {
  const token = getApiKey();
  const base = getBaseUrlValue();
  const wsProtocol = base
    ? base.startsWith("https")
      ? "wss:"
      : "ws:"
    : location.protocol === "https:"
      ? "wss:"
      : "ws:";

  if (base) {
    return `${wsProtocol}//${new URL(base).host}/api/hermes/terminal${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  }

  const directDevPort = import.meta.env.VITE_HERMES_DIRECT_WS_PORT;
  const host = import.meta.env.DEV && directDevPort
    ? formatHostForPort(location.hostname, Number(directDevPort))
    : location.host;
  return `${wsProtocol}//${host}/api/hermes/terminal${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}

function connect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    connectionError.value = t('terminal.connectionFailed');
    isConnecting.value = false;
    return;
  }

  const url = buildWsUrl();
  connectionError.value = null;
  isConnecting.value = true;
  reconnectAttempts++;

  ws = new WebSocket(url);

  ws.onopen = () => {
    isConnecting.value = false;
    connectionError.value = null;
  };

  ws.onmessage = (event) => {
    const data = typeof event.data === "string" ? event.data : "";
    if (data.charCodeAt(0) === 0x7b) {
      try {
        handleControl(JSON.parse(data));
      } catch {}
    } else {
      activeTerm?.write(data);
    }
  };

  ws.onclose = (event) => {
    isConnecting.value = false;

    // 如果是正常关闭（code 1000）或认证失败，不重连
    if (event.code === 1000 || event.code === 1003 || event.code === 1008) {
      connectionError.value = t('terminal.connectionClosed');
      return;
    }

    // 其他情况尝试重连
    setTimeout(connect, 3000);
  };

  ws.onerror = (error) => {
    console.error('[Terminal] WebSocket error:', error);
    connectionError.value = t('terminal.connectionError');
  };
}

function send(data: object | string) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(typeof data === "string" ? data : JSON.stringify(data));
}

// ─── Control message handlers ──────────────────────────────────

function handleControl(msg: any) {
  switch (msg.type) {
    case "created":
      reconnectAttempts = 0;
      sessions.value.push({
        id: msg.id,
        shell: msg.shell,
        pid: msg.pid,
        title: `${msg.shell} #${sessions.value.length + 1}`,
        createdAt: Date.now(),
        exited: false,
      });
      switchSession(msg.id);
      runInitialCommand();
      break;

    case "exited": {
      const s = sessions.value.find((s) => s.id === msg.id);
      if (s) {
        s.exited = true;
        if (activeSessionId.value === msg.id) {
          activeTerm?.write(
            `\r\n\x1b[90m[${t("terminal.processExited", { code: msg.exitCode })}]\x1b[0m\r\n`,
          );
        }
      }
      break;
    }

    case "error":
      message.error(msg.message);
      break;
  }
}

// ─── Session actions ────────────────────────────────────────────

function createSession() {
  send({ type: "create" });
}

function runInitialCommand() {
  const command = props.initialCommand?.trim();
  if (!command || initialCommandSent.value) return;
  initialCommandSent.value = true;
  scheduleInitialCommandChunk(`${command}\r`, 0, 100);
}

function scheduleInitialCommandChunk(command: string, offset: number, delay: number) {
  const timer = setTimeout(() => {
    initialCommandTimers.delete(timer);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const nextOffset = Math.min(offset + INITIAL_COMMAND_CHUNK_SIZE, command.length);
    send({ type: "input", data: command.slice(offset, nextOffset) });
    if (nextOffset < command.length) {
      scheduleInitialCommandChunk(command, nextOffset, INITIAL_COMMAND_CHUNK_DELAY_MS);
    }
  }, delay);
  initialCommandTimers.add(timer);
}

function getOrCreateTerm(id: string): { term: Terminal; fitAddon: FitAddon } {
  let entry = termMap.get(id);
  if (!entry) {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: { ...TERMINAL_THEMES[selectedTheme.value].theme },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.onData((data) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });
    entry = { term, fitAddon, opened: false };
    termMap.set(id, entry);
  }
  return entry;
}

function switchSession(id: string) {
  if (activeSessionId.value === id) return;
  activeSessionId.value = id;
  const entry = getOrCreateTerm(id);
  activeTerm = entry.term;
  activeFitAddon = entry.fitAddon;
  mountActiveTerminal();
  send({ type: "switch", sessionId: id });
}

function closeSession(id: string) {
  send({ type: "close", sessionId: id });
  sessions.value = sessions.value.filter((s) => s.id !== id);
  const entry = termMap.get(id);
  if (entry) {
    entry.term.dispose();
    termMap.delete(id);
  }
  if (activeSessionId.value === id) {
    const nextSessionId = sessions.value[0]?.id ?? null;
    activeSessionId.value = null;
    activeTerm = null;
    activeFitAddon = null;
    if (nextSessionId) {
      switchSession(nextSessionId);
    } else {
      unmountActiveTerminal();
      createSession();
    }
  }
}

// ─── Terminal mount/unmount ─────────────────────────────────────

function mountActiveTerminal() {
  if (!terminalRef.value) return;
  const container = terminalRef.value;
  while (container.firstChild) container.removeChild(container.firstChild);

  const entry = termMap.get(activeSessionId.value!);
  if (!entry) return;

  if (!entry.opened) {
    entry.term.open(container);
    entry.opened = true;
  } else {
    const termEl = entry.term.element;
    if (termEl) {
      container.appendChild(termEl);
    }
  }

  resizeObserver?.disconnect();
  resizeObserver = new ResizeObserver(() => {
    tryFit();
    sendResize();
  });
  resizeObserver.observe(terminalRef.value);

  setTimeout(() => tryFit(), 50);
  setTimeout(() => tryFit(), 200);
}

function unmountActiveTerminal() {
  if (!terminalRef.value) return;
  const container = terminalRef.value;
  while (container.firstChild) container.removeChild(container.firstChild);
}

function tryFit() {
  if (!activeFitAddon) return;
  try {
    activeFitAddon.fit();
  } catch {}
}

function sendResize() {
  if (!activeTerm || !ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    send({
      type: "resize",
      cols: activeTerm.cols,
      rows: activeTerm.rows,
    });
  } catch {}
}

function handleTerminalTouchStart(event: TouchEvent) {
  if (event.touches.length !== 1) {
    touchScrollLastY = null;
    touchScrollRemainder = 0;
    return;
  }
  touchScrollLastY = event.touches[0].clientY;
  touchScrollRemainder = 0;
}

function handleTerminalTouchMove(event: TouchEvent) {
  if (!activeTerm || event.touches.length !== 1 || touchScrollLastY === null) return;
  const nextY = event.touches[0].clientY;
  touchScrollRemainder += touchScrollLastY - nextY;
  touchScrollLastY = nextY;

  const lines = Math.trunc(touchScrollRemainder / TOUCH_SCROLL_LINE_PX);
  if (lines === 0) return;

  activeTerm.scrollLines(lines);
  touchScrollRemainder -= lines * TOUCH_SCROLL_LINE_PX;
  event.preventDefault();
}

function handleTerminalTouchEnd() {
  touchScrollLastY = null;
  touchScrollRemainder = 0;
}

// ─── Theme ───────────────────────────────────────────────────────

function applyTheme(themeName: string) {
  selectedTheme.value = themeName;
  localStorage.setItem(STORAGE_KEY_THEME, themeName);
  const themeObj = TERMINAL_THEMES[themeName]?.theme;
  if (!themeObj) return;
  for (const entry of termMap.values()) {
    entry.term.options.theme = { ...themeObj };
  }
}

function cycleTheme() {
  const themeNames = Object.keys(TERMINAL_THEMES);
  const currentIndex = themeNames.indexOf(selectedTheme.value);
  applyTheme(themeNames[(currentIndex + 1 + themeNames.length) % themeNames.length]);
}

// ─── Lifecycle ──────────────────────────────────────────────────

let hasConnected = false;

watch(() => props.visible, (visible) => {
  if (visible && !hasConnected && !ws) {
    hasConnected = true;
    connect();
  }
}, { immediate: true });

onUnmounted(() => {
  for (const timer of initialCommandTimers) clearTimeout(timer);
  initialCommandTimers.clear();
  unmountActiveTerminal();
  for (const entry of termMap.values()) {
    entry.term.dispose();
  }
  termMap.clear();
  activeTerm = null;
  activeFitAddon = null;
  ws?.close();
  ws = null;
});
</script>

<template>
  <div class="terminal-panel-drawer">
    <aside class="terminal-session-rail" :aria-label="t('terminal.sessions')">
      <NTooltip trigger="hover" placement="right">
        <template #trigger>
          <button
            class="terminal-rail-button terminal-theme-button"
            type="button"
            :aria-label="selectedThemeLabel"
            @click="cycleTheme"
          >
            {{ selectedThemeInitial }}
          </button>
        </template>
        {{ selectedThemeLabel }}
      </NTooltip>

      <div class="terminal-session-list">
        <div
          v-for="session in sessions"
          :key="session.id"
          class="terminal-session-slot"
          :class="{
            active: session.id === activeSessionId,
            exited: session.exited,
          }"
        >
          <NTooltip trigger="hover" placement="right">
            <template #trigger>
              <button
                class="terminal-session-button"
                type="button"
                :aria-label="session.title"
                :aria-pressed="session.id === activeSessionId"
                @click="switchSession(session.id)"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="3" y="4" width="18" height="16" rx="2" />
                  <path d="m7 9 3 3-3 3M13 15h4" />
                </svg>
              </button>
            </template>
            {{ session.title }}
          </NTooltip>
          <NPopconfirm @positive-click="closeSession(session.id)">
            <template #trigger>
              <button
                class="terminal-session-delete"
                type="button"
                :title="t('terminal.closeSession')"
                :aria-label="`${t('terminal.closeSession')}: ${session.title}`"
                @click.stop
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m7 7 10 10M17 7 7 17" />
                </svg>
              </button>
            </template>
            {{ t("terminal.closeSession") }}
          </NPopconfirm>
        </div>
      </div>

      <NTooltip trigger="hover" placement="right">
        <template #trigger>
          <button
            class="terminal-rail-button terminal-add-button"
            type="button"
            :aria-label="t('terminal.newTab')"
            @click="createSession"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </template>
        {{ t("terminal.newTab") }}
      </NTooltip>
    </aside>

    <div class="terminal-main">
      <div class="terminal-container">
        <div v-if="connectionError" class="terminal-state terminal-state-error">
          <span>{{ connectionError }}</span>
          <NButton size="tiny" @click="connect">{{ t("common.retry") }}</NButton>
        </div>
        <div
          v-else-if="sessions.length === 0"
          class="terminal-state"
        >
          <NSpin v-if="isConnecting" :description="t('common.loading')" />
          <template v-else>{{ t('terminal.noSessions') }}</template>
        </div>
        <div
          ref="terminalRef"
          class="terminal-xterm"
          :style="{ backgroundColor: terminalBg }"
          @touchstart="handleTerminalTouchStart"
          @touchmove="handleTerminalTouchMove"
          @touchend="handleTerminalTouchEnd"
          @touchcancel="handleTerminalTouchEnd"
        />
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.terminal-panel-drawer {
  display: flex;
  height: 100%;
  width: 100%;
  min-height: 0;
  min-width: 0;
  position: relative;
  overflow: hidden;
}

.terminal-session-rail {
  width: 48px;
  border-inline-end: 1px solid $border-color;
  background: $bg-sidebar-surface;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 8px 0;
  flex-shrink: 0;
  box-sizing: border-box;
}

.terminal-session-list {
  flex: 1;
  width: 100%;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }
}

.terminal-rail-button,
.terminal-session-button,
.terminal-session-delete {
  border: none;
  background: transparent;
  border-radius: $radius-sm;
  cursor: pointer;
  color: $text-secondary;
  display: grid;
  place-items: center;
  transition:
    color $transition-fast,
    background-color $transition-fast,
    opacity $transition-fast;
}

.terminal-rail-button,
.terminal-session-slot,
.terminal-session-button {
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
}

.terminal-rail-button,
.terminal-session-button {
  &:hover {
    color: $text-primary;
    background: rgba(var(--accent-primary-rgb), 0.08);
  }
}

.terminal-theme-button {
  flex-shrink: 0;
  color: $text-primary;
  background: rgba(var(--accent-primary-rgb), 0.08);
  font-size: 13px;
  font-weight: 700;
  line-height: 1;
}

.terminal-add-button {
  flex-shrink: 0;

  svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
  }
}

.terminal-session-slot {
  position: relative;
  border-radius: $radius-sm;

  &.active {
    background: rgba(var(--accent-primary-rgb), 0.12);

    &::before {
      content: "";
      position: absolute;
      left: -6px;
      top: 9px;
      bottom: 9px;
      width: 2px;
      border-radius: 0 2px 2px 0;
      background: var(--accent-primary);
    }
  }

  &.exited {
    opacity: 0.5;
  }

  &:hover .terminal-session-delete,
  &:focus-within .terminal-session-delete {
    opacity: 1;
    pointer-events: auto;
  }
}

.terminal-session-button {
  padding: 0;

  svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
}

.terminal-session-delete {
  position: absolute;
  top: 1px;
  right: 1px;
  z-index: 2;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 1px solid $border-color;
  border-radius: 50%;
  color: $text-muted;
  background: $bg-card;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
  opacity: 0;
  pointer-events: none;

  svg {
    width: 11px;
    height: 11px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
  }

  &:hover {
    color: $error;
    border-color: rgba(var(--error-rgb), 0.35);
    background: rgba(var(--error-rgb), 0.08);
  }
}

.terminal-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.terminal-container {
  position: relative;
  flex: 1;
  margin: 0;
  overflow: hidden;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.terminal-state {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  color: $text-muted;
  font-size: 12px;
  text-align: center;
  background: $bg-card;
}

.terminal-state-error {
  color: $error;
}

.terminal-xterm {
  flex: 1;
  min-height: 0;
  min-width: 0;
  border-radius: 0;
  overflow: hidden;
  border: 0;

  :deep(.xterm) {
    height: 100%;
    padding: 8px;
  }

  :deep(.xterm-viewport) {
    overflow-y: scroll !important;
    scrollbar-width: none !important;
    -ms-overflow-style: none !important;
    background-color: transparent !important;
  }

  :deep(.xterm-viewport::-webkit-scrollbar) {
    display: none !important;
  }

  :deep(.xterm-screen) {
    background-color: transparent !important;
  }

  :deep(.xterm-scrollable-element) {
    scrollbar-width: none !important;
    -ms-overflow-style: none !important;
  }

  :deep(.xterm-scrollable-element::-webkit-scrollbar) {
    display: none !important;
  }
}

@media (max-width: $breakpoint-mobile) {
  .terminal-panel-drawer {
    height: 100%;
    max-height: 100%;
  }

  .terminal-xterm {
    :deep(.xterm) {
      padding: 6px;
    }

    :deep(.xterm-viewport),
    :deep(.xterm-scrollable-element) {
      touch-action: pan-y;
      -webkit-overflow-scrolling: touch;
      overscroll-behavior: contain;
      scrollbar-width: thin !important;
    }

    :deep(.xterm-viewport::-webkit-scrollbar),
    :deep(.xterm-scrollable-element::-webkit-scrollbar) {
      display: block !important;
      width: 6px !important;
    }
  }
}
</style>
