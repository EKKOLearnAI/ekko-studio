<script setup lang="ts">
import { computed,nextTick,onBeforeUnmount,onMounted,ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NAlert,NButton,NDrawer,NDrawerContent,NSpin } from 'naive-ui'
import { fetchPersonFlowConversation,type PersonFlow,type PersonFlowConversation,type PersonFlowMessage } from '@/api/person'
import { onPersonUpdated } from '@/api/studio/chat'
import { personFlowParticipants } from '@/utils/person-flow'
import { createRefreshQueue } from '@/utils/refresh-queue'
import { useTaskDrawerLayout } from '../tasks/useTaskDrawerLayout'
import PersonFlowChatMessage from './PersonFlowChatMessage.vue'

const props = defineProps<{flow:PersonFlow}>()
const emit = defineEmits<{close:[]}>()
const {t} = useI18n()
const {drawerWidth} = useTaskDrawerLayout()
const flow = ref(props.flow)
const entries = ref<PersonFlowMessage[]>([])
const historyKey = ref<string | null>(null)
const beforeId = ref<number | null>(null)
const loading = ref(true),refreshing = ref(false),loadingOlder = ref(false),failed = ref(false)
const viewport = ref<HTMLElement>()
const lifetime = new AbortController()
let timer:ReturnType<typeof setInterval> | undefined
const bots = computed(() => personFlowParticipants(flow.value))
const messages = computed(() => entries.value.map(entry => ({...entry,session_title:bots.value.find(bot => bot.id === entry.session_id)?.title || entry.session_title})))
const atBottom = () => !viewport.value || viewport.value.scrollHeight-viewport.value.scrollTop-viewport.value.clientHeight < 80
const merge = (incoming:PersonFlowMessage[]) => [...new Map([...entries.value,...incoming].map(entry => [entry.id,entry])).values()].sort((a,b) => a.id-b.id)
function readFailed(error:unknown) {
  if ([401,403,404].includes(Number((error as {status?:number})?.status))) {entries.value=[];beforeId.value=null;historyKey.value=null}
  failed.value=true;loading.value=false;refreshing.value=false
}
const reads = createRefreshQueue({
  load: (_key,signal) => fetchPersonFlowConversation(props.flow.id,undefined,signal),
  apply: (result:PersonFlowConversation) => {
    const bottom = atBottom(), first = historyKey.value === null
    const gap = !!entries.value.length && !!result.messages.length && result.has_more && result.messages[0].id > entries.value.at(-1)!.id
    const reset = first || historyKey.value !== result.history_key || gap
    flow.value = result.flow
    if (reset) { entries.value = result.messages;beforeId.value = result.next_before_id }
    else {
      // Fresh pages are authoritative for their range, including removed/hidden entries.
      const oldest = result.messages[0]?.id
      if (oldest !== undefined) {
        const ids = new Set(result.messages.map(entry => entry.id))
        entries.value = entries.value.filter(entry => entry.id < oldest || ids.has(entry.id))
      }
      entries.value = merge(result.messages)
    }
    historyKey.value = result.history_key
    failed.value = false;loading.value = false;refreshing.value = false
    void nextTick(() => {
      if (!lifetime.signal.aborted && (bottom || reset) && viewport.value) viewport.value.scrollTop = viewport.value.scrollHeight
    })
  },
  failed: readFailed,
})
function refresh() {
  if (loadingOlder.value || lifetime.signal.aborted) return
  refreshing.value = true
  return reads.refresh(props.flow.id)
}
async function older() {
  if (!beforeId.value || loadingOlder.value || refreshing.value) return
  loadingOlder.value=true;failed.value=false;reads.cancel()
  const height = viewport.value?.scrollHeight || 0, top = viewport.value?.scrollTop || 0
  try {
    const result = await fetchPersonFlowConversation(props.flow.id,beforeId.value,lifetime.signal)
    if (lifetime.signal.aborted) return
    if (result.history_key !== historyKey.value) {
      loadingOlder.value = false
      await refresh()
      return
    }
    entries.value = merge(result.messages);beforeId.value = result.next_before_id
    await nextTick()
    if (!lifetime.signal.aborted && viewport.value) viewport.value.scrollTop = top+viewport.value.scrollHeight-height
  } catch (error) {if (!lifetime.signal.aborted) readFailed(error)}
  finally {loadingOlder.value=false}
}
const stopUpdates = onPersonUpdated(() => {void refresh()})
function visibility() {if (document.visibilityState === 'visible') void refresh()}
onMounted(() => {
  void refresh()
  timer = setInterval(() => {if (document.visibilityState === 'visible') void refresh()},3000)
  document.addEventListener('visibilitychange',visibility)
})
onBeforeUnmount(() => {lifetime.abort();reads.dispose();stopUpdates();clearInterval(timer);document.removeEventListener('visibilitychange',visibility)})
</script>

<template>
  <NDrawer :show="true" :width="drawerWidth" placement="right" class="person-flow-conversation" @update:show="value => !value && emit('close')">
    <NDrawerContent :title="flow.title" closable :native-scrollbar="false" :body-content-style="{display:'flex',flexDirection:'column',height:'100%',padding:'0'}">
      <NAlert v-if="failed" type="error" class="flow-conversation-error">{{t('person.flowChatLoadFailed')}}<NButton size="small" :disabled="refreshing || loadingOlder" @click="refresh">{{t('sessionTasks.retry')}}</NButton></NAlert>
      <div v-if="loading" class="flow-conversation-loading"><NSpin /></div>
      <div v-else ref="viewport" class="flow-conversation-messages" role="log" :aria-label="t('person.flowChat')" aria-live="polite" aria-relevant="additions text">
        <NButton v-if="beforeId" class="flow-conversation-older" quaternary :loading="loadingOlder" :disabled="refreshing" @click="older">{{t('person.older')}}</NButton>
        <p v-if="!messages.length && !failed" class="flow-conversation-empty">{{t('person.flowChatEmpty')}}</p>
        <PersonFlowChatMessage v-for="entry in messages" :key="entry.id" :entry="entry" />
      </div>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;
.flow-conversation-messages { flex:1; min-height:0; overflow:auto; overscroll-behavior:contain; padding:20px; display:flex; flex-direction:column; gap:20px; }
.flow-conversation-older { align-self:center; flex-shrink:0; }
.flow-conversation-loading { flex:1; display:grid; place-items:center; }
.flow-conversation-empty { margin:auto; padding:24px; color:$text-muted; text-align:center; }
.flow-conversation-error { margin:12px 20px; flex-shrink:0; }
@media (max-width:640px) { .flow-conversation-messages { padding:16px; } }
</style>
