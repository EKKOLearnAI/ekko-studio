<script setup lang="ts">
import PageHeader from '@/components/layout/PageHeader.vue'
import { ref, onMounted, onUnmounted, computed } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { getApiKey, getBaseUrlValue } from "@/api/client";
import { NSpin, NButton, NPopconfirm, NTooltip, NSelect, useMessage } from "naive-ui";
import { useI18n } from "vue-i18n";
import type { ITheme } from "@xterm/xterm";

const { t } = useI18n();
const message = useMessage();

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
  "solarized-light": {
    label: "Solarized Light",
    theme: {
      background: "#fdf6e3", foreground: "#657b83",
      cursor: "#586e75", cursorAccent: "#fdf6e3",
      selectionBackground: "rgba(88, 110, 117, 0.3)",
      black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900",
      blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
      brightBlack: "#002b36", brightRed: "#cb4b16", brightGreen: "#586e75",
      brightYellow: "#657b83", brightBlue: "#839496", brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
    },
  },
  monokai: {
    label: "Monokai",
    theme: {
      background: "#272822", foreground: "#f8f8f2",
      cursor: "#f8f8f0", cursorAccent: "#272822",
      selectionBackground: "rgba(248, 248, 242, 0.2)",
      black: "#272822", red: "#f92672", green: "#a6e22e", yellow: "#f4bf75",
      blue: "#66d9ef", magenta: "#ae81ff", cyan: "#a1efe4", white: "#f8f8f2",
      brightBlack: "#75715e", brightRed: "#fd971f", brightGreen: "#a6e22e",
      brightYellow: "#e6db74", brightBlue: "#66d9ef", brightMagenta: "#ae81ff",
      brightCyan: "#a1efe4", brightWhite: "#f9f8f5",
    },
  },
  dracula: {
    label: "Dracula",
    theme: {
      background: "#282a36", foreground: "#f8f8f2",
      cursor: "#f8f8f2", cursorAccent: "#282a36",
      selectionBackground: "rgba(248, 248, 242, 0.2)",
      black: "#21222c", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c",
      blue: "#bd93f9", magenta: "#ff79c6", cyan: "#8be9fd", white: "#f8f8f2",
      brightBlack: "#6272a4", brightRed: "#ff6e6e", brightGreen: "#69ff94",
      brightYellow: "#ffffa5", brightBlue: "#d6acff", brightMagenta: "#ff92df",
      brightCyan: "#a4ffff", brightWhite: "#ffffff",
    },
  },
  nord: {
    label: "Nord",
    theme: {
      background: "#2e3440", foreground: "#d8dee9",
      cursor: "#d8dee9", cursorAccent: "#2e3440",
      selectionBackground: "rgba(216, 222, 233, 0.2)",
      black: "#3b4252", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b",
      blue: "#81a1c1", magenta: "#b48ead", cyan: "#88c0d0", white: "#e5e9f0",
      brightBlack: "#4c566a", brightRed: "#bf616a", brightGreen: "#a3be8c",
      brightYellow: "#ebcb8b", brightBlue: "#81a1c1", brightMagenta: "#b48ead",
      brightCyan: "#8fbcbb", brightWhite: "#eceff4",
    },
  },
  "one-dark": {
    label: "One Dark",
    theme: {
      background: "#282c34", foreground: "#abb2bf",
      cursor: "#528bff", cursorAccent: "#282c34",
      selectionBackground: "rgba(82, 139, 255, 0.25)",
      black: "#282c34", red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
      blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#abb2bf",
      brightBlack: "#5c6370", brightRed: "#e06c75", brightGreen: "#98c379",
      brightYellow: "#e5c07b", brightBlue: "#61afef", brightMagenta: "#c678dd",
      brightCyan: "#56b6c2", brightWhite: "#ffffff",
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
  "github-light": {
    label: "GitHub Light",
    theme: {
      background: "#ffffff", foreground: "#24292f",
      cursor: "#0969da", cursorAccent: "#ffffff",
      selectionBackground: "rgba(9, 105, 218, 0.2)",
      black: "#24292f", red: "#cf222e", green: "#116329", yellow: "#4d2d00",
      blue: "#0969da", magenta: "#8250df", cyan: "#1b7c83", white: "#57606a",
      brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37",
      brightYellow: "#633c01", brightBlue: "#218bff", brightMagenta: "#a475f4",
      brightCyan: "#3192aa", brightWhite: "#8c959f",
    },
  },
  "catppuccin-latte": {
    label: "Catppuccin Latte",
    theme: {
      background: "#eff1f5", foreground: "#4c4f69",
      cursor: "#dc8a78", cursorAccent: "#eff1f5",
      selectionBackground: "rgba(220, 138, 120, 0.2)",
      black: "#5c5f77", red: "#d20f39", green: "#40a02b", yellow: "#df8e1d",
      blue: "#1e66f5", magenta: "#ea76cb", cyan: "#179299", white: "#4c4f69",
      brightBlack: "#6c6f85", brightRed: "#d20f39", brightGreen: "#40a02b",
      brightYellow: "#df8e1d", brightBlue: "#1e66f5", brightMagenta: "#ea76cb",
      brightCyan: "#179299", brightWhite: "#bcc0cc",
    },
  },
  "alabaster-light": {
    label: "Alabaster",
    theme: {
      background: "#f7f7f7", foreground: "#434343",
      cursor: "#528bff", cursorAccent: "#f7f7f7",
      selectionBackground: "rgba(82, 139, 255, 0.2)",
      black: "#000000", red: "#aa3731", green: "#448c27", yellow: "#cb9000",
      blue: "#325cc0", magenta: "#7a3e9d", cyan: "#0083b2", white: "#434343",
      brightBlack: "#777777", brightRed: "#f05050", brightGreen: "#60cb00",
      brightYellow: "#ffbc5d", brightBlue: "#0070ea", brightMagenta: "#ca64e2",
      brightCyan: "#00aacb", brightWhite: "#999999",
    },
  },
  "xterm-light": {
    label: "XTerm Light",
    theme: {
      background: "#fafafa", foreground: "#383a42",
      cursor: "#526fff", cursorAccent: "#fafafa",
      selectionBackground: "rgba(82, 111, 255, 0.2)",
      black: "#383a42", red: "#e45649", green: "#50a14f", yellow: "#c18401",
      blue: "#4078f2", magenta: "#a626a4", cyan: "#0184bc", white: "#a0a1a7",
      brightBlack: "#4f525e", brightRed: "#e06c75", brightGreen: "#98c379",
      brightYellow: "#e5c07b", brightBlue: "#61afef", brightMagenta: "#c678dd",
      brightCyan: "#56b6c2", brightWhite: "#ffffff",
    },
  },
  "one-light": {
    label: "One Light",
    theme: {
      background: "#fafafa", foreground: "#383a42",
      cursor: "#526eff", cursorAccent: "#fafafa",
      selectionBackground: "rgba(82, 110, 255, 0.2)",
      black: "#383a42", red: "#e45649", green: "#50a14f", yellow: "#c18401",
      blue: "#4078f2", magenta: "#a626a4", cyan: "#0184bc", white: "#a0a1a7",
      brightBlack: "#4f525e", brightRed: "#e06c75", brightGreen: "#98c379",
      brightYellow: "#e5c07b", brightBlue: "#61afef", brightMagenta: "#c678dd",
      brightCyan: "#56b6c2", brightWhite: "#ffffff",
    },
  },
  "gruvbox-light": {
    label: "Gruvbox Light",
    theme: {
      background: "#fbf1c7", foreground: "#3c3836",
      cursor: "#9d0006", cursorAccent: "#fbf1c7",
      selectionBackground: "rgba(157, 0, 6, 0.15)",
      black: "#fbf1c7", red: "#cc241d", green: "#98971a", yellow: "#d79921",
      blue: "#458588", magenta: "#b16286", cyan: "#689d6a", white: "#504945",
      brightBlack: "#928374", brightRed: "#9d0006", brightGreen: "#79740e",
      brightYellow: "#b57614", brightBlue: "#076678", brightMagenta: "#8f3f71",
      brightCyan: "#427b58", brightWhite: "#3c3836",
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
const showSessions = ref(true);
const sessions = ref<SessionInfo[]>([]);
const activeSessionId = ref<string | null>(null);
const selectedTheme = ref(localStorage.getItem(STORAGE_KEY_THEME) || "default");

let ws: WebSocket | null = null;
// Keep all terminal instances alive, only dispose on close
const termMap = new Map<
  string,
  { term: Terminal; fitAddon: FitAddon; opened: boolean }
>();
let activeTerm: Terminal | null = null;
let activeFitAddon: FitAddon | null = null;
let resizeObserver: ResizeObserver | null = null;
let mobileQuery: MediaQueryList | null = null;
let touchScrollLastY: number | null = null;
let touchScrollRemainder = 0;
const TOUCH_SCROLL_LINE_PX = 18;

// ─── Computed ──────────────────────────────────────────────────

const activeSession = computed(
  () => sessions.value.find((s) => s.id === activeSessionId.value) || null,
);

const themeOptions = computed(() =>
  Object.entries(TERMINAL_THEMES).map(([key, val]) => ({
    label: val.label,
    value: key,
  })),
);

const terminalBg = computed(
  () => TERMINAL_THEMES[selectedTheme.value]?.theme.background ?? "#1a1a2e",
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
  const url = buildWsUrl();
  ws = new WebSocket(url);

  ws.onopen = () => {
    // Server auto-creates the first session and sends 'created'
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

  // On reconnect, recreate all terminals for existing sessions
  ws.onopen = () => {
    // Server will auto-create the first session again
  };

  ws.onclose = () => {
    // Reconnect after delay
    setTimeout(connect, 3000);
  };

  ws.onerror = () => {
    // let onclose handle reconnect
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
      sessions.value.push({
        id: msg.id,
        shell: msg.shell,
        pid: msg.pid,
        title: `${msg.shell} #${sessions.value.length + 1}`,
        createdAt: Date.now(),
        exited: false,
      });
      switchSession(msg.id);
      break;

    case "switched":
      // Server confirmed switch — frontend already mounted in switchSession()
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
  if (mobileQuery?.matches) showSessions.value = false;
}

function closeSession(id: string) {
  send({ type: "close", sessionId: id });
  sessions.value = sessions.value.filter((s) => s.id !== id);
  // Dispose terminal instance
  const entry = termMap.get(id);
  if (entry) {
    entry.term.dispose();
    termMap.delete(id);
  }
  if (activeSessionId.value === id) {
    activeSessionId.value =
      sessions.value.length > 0 ? sessions.value[0].id : null;
    activeTerm = null;
    activeFitAddon = null;
    if (activeSessionId.value) {
      switchSession(activeSessionId.value);
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
  // Remove old terminal DOM from container
  while (container.firstChild) container.removeChild(container.firstChild);

  const entry = termMap.get(activeSessionId.value!);
  if (!entry) return;

  if (!entry.opened) {
    // First time: call open()
    entry.term.open(container);
    entry.opened = true;
  } else {
    // Already opened: move the existing DOM element
    const termEl = entry.term.element;
    if (termEl) {
      container.appendChild(termEl);
    }
  }

  // Resize observer
  resizeObserver?.disconnect();
  resizeObserver = new ResizeObserver(() => {
    tryFit();
    sendResize();
  });
  resizeObserver.observe(terminalRef.value);

  // Fit after DOM is ready
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

// ─── Helpers ────────────────────────────────────────────────────

function formatTime(ts: number) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function handleMobileChange(e: MediaQueryListEvent | MediaQueryList) {
  if (e.matches && showSessions.value) showSessions.value = false;
}

// ─── Lifecycle ──────────────────────────────────────────────────

onMounted(() => {
  mobileQuery = window.matchMedia("(max-width: 768px)");
  handleMobileChange(mobileQuery);
  mobileQuery.addEventListener("change", handleMobileChange);
  connect();
});

onUnmounted(() => {
  mobileQuery?.removeEventListener("change", handleMobileChange);
  unmountActiveTerminal();
  // Dispose all terminal instances
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
  <div class="terminal-panel">
    <!-- Session backdrop (mobile) -->
    <div
      class="session-backdrop"
      :class="{ active: showSessions }"
      @click="showSessions = false"
    />

    <!-- Session list sidebar -->
    <aside class="session-list" :class="{ collapsed: !showSessions }">
      <div class="session-list-header">
        <span v-if="showSessions" class="session-list-title">{{
          t("terminal.sessions")
        }}</span>
        <div class="session-list-actions">
          <!-- <button class="session-close-btn" @click="showSessions = false">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button> -->
          <NTooltip trigger="hover">
            <template #trigger>
              <NButton quaternary size="tiny" @click="createSession" circle>
                <template #icon>
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                  >
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </template>
              </NButton>
            </template>
            {{ t("terminal.newTab") }}
          </NTooltip>
        </div>
      </div>
      <div v-if="showSessions" class="session-items">
        <div v-if="sessions.length === 0" class="session-empty">
          <NSpin size="small" :description="t('common.loading')" />
        </div>
        <button
          v-for="s in sessions"
          :key="s.id"
          class="session-item"
          :class="{ active: s.id === activeSessionId, exited: s.exited }"
          @click="switchSession(s.id)"
        >
          <div class="session-item-content">
            <span class="session-item-title">{{ s.title }}</span>
            <span class="session-item-meta">
              <span class="session-item-shell">{{ s.shell }}</span>
              <span v-if="s.exited" class="session-item-status">{{
                t("terminal.sessionExited")
              }}</span>
              <span v-else class="session-item-time">{{
                formatTime(s.createdAt)
              }}</span>
            </span>
          </div>
          <NPopconfirm
            v-if="sessions.length > 1"
            @positive-click="closeSession(s.id)"
          >
            <template #trigger>
              <button class="session-item-delete" @click.stop>
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </template>
            {{ t("terminal.closeSession") }}
          </NPopconfirm>
        </button>
      </div>
    </aside>

    <!-- Main terminal area -->
    <div class="terminal-main">
      <PageHeader>
      <header class="terminal-header">
        <div class="header-left">
          <NButton
            quaternary
            size="small"
            @click="showSessions = !showSessions"
            circle
          >
            <template #icon>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
              >
                <rect x="3" y="3" width="7" height="7" />
                <rect x="14" y="3" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" />
              </svg>
            </template>
          </NButton>
          <span v-if="activeSession" class="header-session-title">{{
            activeSession.title
          }}</span>
        </div>
        <div class="header-actions">
          <NSelect
            :value="selectedTheme"
            :options="themeOptions"
            size="small"
            :consistent-menu-width="false"
            class="theme-select"
            @update:value="applyTheme"
          />
          <NButton size="small" @click="createSession">
            <template #icon>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </template>
            {{ t("terminal.newTab") }}
          </NButton>
        </div>
      </header>
      </PageHeader>
      <div class="terminal-container">
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

.terminal-panel {
  display: flex;
  height: 100%;
  position: relative;
}

// ─── Session list ──────────────────────────────────────────────

.session-list {
  width: 220px;
  border-inline-end: 1px solid $border-color;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  transition:
    width $transition-normal,
    opacity $transition-normal;
  overflow: hidden;

  &.collapsed {
    width: 0;
    border-inline-end: none;
    opacity: 0;
    pointer-events: none;
  }

  @media (max-width: $breakpoint-mobile) {
    position: absolute;
    left: 0;
    top: 0;
    height: 100%;
    z-index: 10;
    background: $bg-card;
    box-shadow: 2px 0 8px rgba(0, 0, 0, 0.1);
    width: 280px;

    &.collapsed {
      transform: translateX(-100%);
      opacity: 0;
    }
  }
}

.session-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  flex-shrink: 0;
}

.session-list-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.session-list-title {
  font-size: 12px;
  font-weight: 600;
  color: $text-muted;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.session-items {
  flex: 1;
  overflow-y: auto;
  padding: 0 6px 12px;
}

.session-empty {
  padding: 16px 10px;
  font-size: 12px;
  color: $text-muted;
  text-align: center;
}

.session-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 8px 10px;
  border: none;
  background: none;
  border-radius: $radius-sm;
  cursor: pointer;
  text-align: start;
  color: $text-secondary;
  transition: all $transition-fast;
  margin-bottom: 2px;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.06);
    color: $text-primary;

    .session-item-delete {
      opacity: 1;
    }
  }

  &.active {
    background: rgba(var(--accent-primary-rgb), 0.1);
    color: $text-primary;
    font-weight: 500;
  }

  &.exited {
    opacity: 0.5;
  }
}

.session-item-content {
  flex: 1;
  overflow: hidden;
}

.session-item-title {
  display: block;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-item-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}

.session-item-shell {
  font-size: 10px;
  color: $accent-primary;
  background: rgba(var(--accent-primary-rgb), 0.08);
  padding: 0 5px;
  border-radius: 3px;
  line-height: 16px;
}

.session-item-time {
  font-size: 11px;
  color: $text-muted;
}

.session-item-status {
  font-size: 11px;
  color: $text-muted;
  font-style: italic;
}

.session-item-delete {
  flex-shrink: 0;
  opacity: 0.5;
  padding: 2px;
  border: none;
  background: none;
  color: $text-muted;
  cursor: pointer;
  border-radius: 3px;
  transition: all $transition-fast;

  &:hover {
    color: $error;
    background: rgba(var(--error-rgb), 0.1);
  }
}

.session-close-btn {
  display: none;
  border: none;
  background: none;
  cursor: pointer;
  color: $text-secondary;
  padding: 4px;
  border-radius: $radius-sm;

  &:hover {
    background: rgba(var(--accent-primary-rgb), 0.06);
  }
}

// ─── Main area ──────────────────────────────────────────────────

.terminal-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

.terminal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 21px 20px;
  border-bottom: 1px solid $border-color;
  flex-shrink: 0;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  overflow: hidden;
  flex: 1;
  min-width: 0;
}

.header-session-title {
  font-size: 16px;
  font-weight: 600;
  color: $text-primary;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.theme-select {
  width: 130px;
}

@container studio-page-header (max-width: 400px) {
  .theme-select { width: 100px; }
}

// ─── Terminal container ─────────────────────────────────────────

.terminal-container {
  flex: 1;
  margin: 10px;
  overflow: hidden;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.terminal-xterm {
  flex: 1;
  border-radius: $radius-md;
  overflow: hidden;
  border: 1px solid $border-color;

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

// ─── Mobile ─────────────────────────────────────────────────────

@media (max-width: $breakpoint-mobile) {
  .terminal-panel {
    height: calc(100 * var(--vh));
    max-height: calc(100 * var(--vh));
  }

  .terminal-main {
    min-height: 0;
  }

  .terminal-container {
    margin-bottom: calc(8px + env(safe-area-inset-bottom, 0px));
  }

  .session-close-btn {
    display: flex;
  }

  .session-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 9;
    opacity: 0;
    pointer-events: none;
    transition: opacity $transition-fast;

    &.active {
      opacity: 1;
      pointer-events: auto;
    }
  }

  .terminal-header {
    padding: 16px 12px 16px 52px;
  }

  .terminal-container {
    padding: 8px;
  }

  .terminal-xterm {
    left: 0;
    right: 0;
    bottom: 0;

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

<style lang="scss">
/* Global: xterm scrollbar (scoped :deep can't reach dynamically created elements) */
.xterm .scrollbar {
  width: 6px !important;
  border-radius: 3px !important;
  background: rgba(255, 255, 255, 0.08) !important;
}

.xterm .scrollbar .slider {
  border-radius: 3px !important;
  background: rgba(255, 255, 255, 0.2) !important;
  transition: background 0.15s ease !important;
}

.xterm .scrollbar:hover .slider {
  background: rgba(255, 255, 255, 0.35) !important;
}
</style>
