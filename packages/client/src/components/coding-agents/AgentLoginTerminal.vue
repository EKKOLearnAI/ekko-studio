<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { NAlert, NButton, NTag } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useTheme } from '@/composables/useTheme'
import { terminalTheme } from '@/styles/theme-integrations'
import { generateClientUuid } from '@/utils/client-random'
import { fetchAgentManagementOperations, fetchAgentManagementOperation, fetchAgentManagementOutput, startAgentLogin, startAgentInstall,
  sendAgentManagementInput, resizeAgentManagementTerminal, cancelAgentManagementOperation,
  type AgentManagementOperation, type ManagedAgentInstance } from '@/api/studio/agent-management'

const props = withDefaults(defineProps<{ profile: string; instance: ManagedAgentInstance; action?: 'login' | 'install'; disabled?: boolean }>(), { action: 'login', disabled: false })
const emit = defineEmits<{ busy: [active: boolean]; ended: [] }>()
const { t } = useI18n(), { customization, isDark } = useTheme()
const receipt = shallowRef<AgentManagementOperation | null>(null), error = ref(''), truncated = ref(false), working = ref(false), connected = ref(false), host = ref<HTMLElement>()
const drained = ref(true)
const active = computed(() => receipt.value ? ['starting', 'running'].includes(receipt.value.status) : false)
let terminal: Terminal | undefined, fit: FitAddon | undefined, observer: ResizeObserver | undefined
let alive = true, cursor = 0, sequence = 1, inputInitialized = false, sending = false, pending = '', frame: { sequence: number; text: string } | undefined
let pollTimer: ReturnType<typeof setTimeout> | undefined, inputTimer: ReturnType<typeof setTimeout> | undefined, resizeTimer: ReturnType<typeof setTimeout> | undefined
let requestKey = generateClientUuid()
let pollTask: Promise<void> | undefined, completeWrite: (() => void) | undefined
const theme = computed(() => terminalTheme(customization.value, isDark.value))
const message = (failure: unknown) => failure instanceof Error ? failure.message : String(failure)
const readOnly = computed(() => props.action === 'install')
const copy = computed(() => `agentManagement.${props.action}`)
watch([active, working], ([value, loading]) => { emit('busy', value || loading); if (terminal) terminal.options.disableStdin = readOnly.value || receipt.value?.status !== 'running' || !!error.value || !inputInitialized }, { immediate: true })
watch(theme, value => { if (terminal) terminal.options.theme = { ...value } })

async function load() {
  working.value = true; error.value = ''
  try {
    const operations = await fetchAgentManagementOperations(props.profile, props.instance.id)
    const matching = operations.filter(operation => operation.action === props.action)
    if (alive) receipt.value = matching.find(operation => ['starting', 'running'].includes(operation.status)) || matching[0] || null
  } catch (failure) { if (alive) error.value = message(failure) }
  finally { if (alive) working.value = false }
}
async function start() {
  if (props.disabled || active.value || working.value || !drained.value) return
  working.value = true; error.value = ''
  try {
    const result = await (readOnly.value ? startAgentInstall : startAgentLogin)(props.profile, props.instance, requestKey)
    if (!alive) return
    clearTimeout(pollTimer); clearTimeout(inputTimer); clearTimeout(resizeTimer)
    observer?.disconnect(); terminal?.dispose(); terminal = undefined; connected.value = false
    cursor = 0; sequence = 1; inputInitialized = false; pending = ''; frame = undefined; truncated.value = false
    receipt.value = result; requestKey = generateClientUuid()
    await connect()
  } catch (failure) { if (alive) error.value = message(failure) }
  finally { if (alive) working.value = false }
}
async function connect() {
  if (!receipt.value || terminal || !alive) return
  working.value = true; error.value = ''; connected.value = true; drained.value = false
  try {
    await nextTick()
    const [{ Terminal: Xterm }, { FitAddon: Fit }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
    if (!alive || !host.value) return
    terminal = new Xterm({ theme: { ...theme.value }, allowTransparency: true, fontSize: customization.value.fontSize, cursorBlink: true,
      fontFamily: 'Menlo, Monaco, monospace', scrollback: 1000, screenReaderMode: true, disableStdin: true })
    fit = new Fit(); terminal.loadAddon(fit); terminal.open(host.value)
    terminal.onData(text => {
      if (readOnly.value || !inputInitialized || receipt.value?.status !== 'running' || error.value) return
      if (new TextEncoder().encode(pending + text).length > 65_536) { failInput(new Error(t('agentManagement.login.inputLimit'))); return }
      pending += text
      if (!inputTimer) inputTimer = setTimeout(() => { inputTimer = undefined; void flushInput() }, 30)
    })
    observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => { fit?.fit(); void resize() }, 100)
    })
    observer.observe(host.value)
    fit.fit(); terminal.focus()
    await poll()
  } catch (failure) { if (alive) { error.value = message(failure); terminal?.dispose(); terminal = undefined; connected.value = false } }
  finally { if (alive) working.value = false }
}
function failInput(failure: unknown) {
  error.value = message(failure)
  if (terminal) terminal.options.disableStdin = true
}
async function flushInput() {
  if (readOnly.value || sending || error.value || !receipt.value || !alive || (!pending && !frame)) return
  sending = true
  if (!frame) { frame = { sequence, text: pending }; pending = '' }
  const submitted = frame
  try {
    await sendAgentManagementInput(props.profile, receipt.value.id, submitted.sequence, submitted.text)
    if (!alive) return
    sequence = submitted.sequence + 1
    if (frame === submitted) frame = undefined
  } catch (failure) { if (alive && active.value) failInput(failure) }
  finally { sending = false }
  if (alive && !error.value && pending) void flushInput()
}
async function resize() {
  if (readOnly.value || !alive || !receipt.value || receipt.value.status !== 'running' || !terminal || error.value) return
  try { await resizeAgentManagementTerminal(props.profile, receipt.value.id, Math.max(2, Math.min(1000, terminal.cols)), Math.max(2, Math.min(1000, terminal.rows))) }
  catch (failure) { if (alive && active.value) failInput(failure) }
}
function poll(): Promise<void> { return pollTask ||= pollOnce().finally(() => { pollTask = undefined }) }
async function pollOnce() {
  if (!receipt.value || !alive || !terminal) return
  try {
    const id = receipt.value.id
    const [output, latest] = await Promise.all([fetchAgentManagementOutput(props.profile, id, cursor), fetchAgentManagementOperation(props.profile, id)])
    if (!alive || !terminal) return
    const wasActive = active.value
    receipt.value = latest; truncated.value ||= output.truncated
    if (!inputInitialized) { sequence = output.nextInputSequence; inputInitialized = true }
    terminal.options.disableStdin = readOnly.value || latest.status !== 'running' || !!error.value
    for (const chunk of output.chunks) {
      if (chunk.sequence <= cursor) continue
      const bytes = Uint8Array.from(atob(chunk.data), char => char.charCodeAt(0))
      await new Promise<void>(resolve => { completeWrite = resolve; terminal!.write(bytes, resolve) })
      completeWrite = undefined
      if (!alive) return
      cursor = chunk.sequence
    }
    cursor = output.lastSequence
    drained.value = output.finished
    if (wasActive && !active.value) { pending = ''; emit('ended') }
    if (!output.finished) pollTimer = setTimeout(() => { pollTimer = undefined; void poll() }, output.chunks.length === 4 ? 0 : 200)
  } catch (failure) { if (alive) failInput(failure) }
}
async function retry() {
  error.value = ''
  if (!terminal) { if (connected.value) connected.value = false; await load(); return }
  // Retry the identical frame first; never assign a new sequence to uncertain input.
  if (frame) await flushInput()
  if (!alive || error.value) return
  clearTimeout(pollTimer); await poll()
  if (terminal) terminal.options.disableStdin = readOnly.value || receipt.value?.status !== 'running' || !!error.value
}
async function cancel() {
  if (!receipt.value) return
  working.value = true; error.value = ''
  try {
    const result = await cancelAgentManagementOperation(props.profile, receipt.value.id)
    if (!alive) return
    receipt.value = result; pending = ''; frame = undefined; emit('ended')
    clearTimeout(pollTimer); await poll()
  } catch (failure) { if (alive) error.value = message(failure) }
  finally { if (alive) working.value = false }
}
onMounted(load)
onUnmounted(() => { alive = false; clearTimeout(pollTimer); clearTimeout(inputTimer); clearTimeout(resizeTimer); observer?.disconnect(); terminal?.dispose(); completeWrite?.(); pending = ''; frame = undefined; emit('busy', false) })
</script>

<template>
  <section class="agent-login" data-theme-surface="card">
    <p>{{ t(`${copy}.hint`) }}</p>
    <div class="login-actions">
      <NButton :loading="working" :disabled="working || active || disabled || !drained" @click="start">{{ t(`${copy}.open`) }}</NButton>
      <NButton v-if="receipt && !connected" :disabled="working" @click="connect">{{ t(`${copy}.reconnect`) }}</NButton>
      <NButton v-if="active" :disabled="working" @click="cancel">{{ t(`${copy}.cancel`) }}</NButton>
      <NTag v-if="receipt">{{ t(`agentManagement.login.${receipt.status}`) }}<template v-if="receipt.errorCode"> · {{ receipt.errorCode }}</template></NTag>
    </div>
    <NAlert v-if="error" type="error" :bordered="false">{{ error }} <NButton size="small" :disabled="working" @click="retry">{{ t('common.retry') }}</NButton></NAlert>
    <NAlert v-if="truncated" type="warning" :bordered="false">{{ t('agentManagement.login.truncated') }}</NAlert>
    <div v-if="connected" ref="host" class="login-terminal" :aria-label="t(`${copy}.terminal`)" :data-readonly="readOnly" />
  </section>
</template>

<style scoped lang="scss">
.agent-login { padding: 16px; min-width: 0; display: flex; flex-direction: column; gap: 12px; p { margin: 0; } }
.login-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.login-terminal { height: min(360px, 50dvh); min-height: 180px; min-width: 0; overflow: hidden; direction: ltr; }
</style>
