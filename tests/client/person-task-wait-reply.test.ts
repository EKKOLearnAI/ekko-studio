// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/hermes/chat'
import { personDisplayEvent, createPersonDisplayStream } from '../../packages/server/src/modules/studio/services/chat-run/person-display'

const api = vi.hoisted(() => ({ start:vi.fn(), resume:vi.fn(), register:vi.fn(), bell:vi.fn() }))
vi.mock('@/api/studio/sessions', () => ({
  archiveSession:vi.fn(),deleteSession:vi.fn(),deleteSessionMessages:vi.fn(),fetchSessionMessagesPage:vi.fn(),fetchSessions:vi.fn(),
  fetchWorkspaceRunChangeFile:vi.fn(),setSessionModel:vi.fn(),setSessionPushEnabled:vi.fn(),setSessionReasoningEffort:vi.fn(),
}))
vi.mock('@/api/studio/chat', () => ({
  startRunViaSocket:api.start,resumeSession:api.resume,registerSessionHandlers:api.register,unregisterSessionHandlers:vi.fn(),
  onUnobservedRunStarted:vi.fn(()=>vi.fn()),getChatRunSocket:vi.fn(()=>({emit:vi.fn()})),
  respondToolApproval:vi.fn(),respondClarify:vi.fn(),onPeerUserMessage:vi.fn(()=>vi.fn()),onSessionCommand:vi.fn(()=>vi.fn()),
  onSessionTitleUpdated:vi.fn(()=>vi.fn()),onSessionWorkspaceUpdated:vi.fn(()=>vi.fn()),onSessionSettingsUpdated:vi.fn(()=>vi.fn()),onRunUsageUpdated:vi.fn(()=>vi.fn()),
}))
vi.mock('@/api/client',()=>({getActiveProfileName:()=> 'default',hasApiKey:()=>false}))
vi.mock('@/api/studio/background-status',()=>({observeBackgroundStatus:()=>vi.fn()}))
vi.mock('@/stores/hermes/app',()=>({useAppStore:()=>({waitForModelsForRun:async()=>{},selectedModel:'fixture',selectedProvider:'fixture',profileModelGroups:[],modelGroups:[]})}))
vi.mock('@/stores/hermes/profiles',()=>({useProfilesStore:()=>({activeProfileName:'default'})}))
vi.mock('@/stores/hermes/settings',()=>({useSettingsStore:()=>({display:{bell_on_complete:true,notify_on_complete:false}})}))
vi.mock('@/utils/completion-sound',()=>({primeCompletionSound:vi.fn(),playCompletionSound:api.bell}))
vi.mock('@/utils/completion-notification',()=>({showCompletionNotification:vi.fn()}))
vi.mock('@/composables/useComputerUsePermissionPrompt',()=>({notifyComputerUseStarted:vi.fn()}))

const sid='person-main-wait-reply'
let store: ReturnType<typeof useChatStore>
beforeEach(()=>{
  vi.clearAllMocks();localStorage.clear();setActivePinia(createPinia())
  vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('Unexpected network request')}))
  store=useChatStore()
  const session:any={id:sid,title:'Fixture',profile:'default',source:'builtin_agent',agent:'ekko-agent',agentPreset:'person',messages:[],createdAt:1,updatedAt:1,messagesLoaded:true,messageCount:1}
  store.sessions=[session];store.activeSession=session;store.activeSessionId=sid
  api.start.mockReturnValue({abort:vi.fn()})
})
afterEach(()=>{store.$dispose();vi.unstubAllGlobals()})
const event=(name:string,extra:Record<string,unknown>={})=>({event:name,session_id:sid,run_id:'dispatch',...extra})
const wait=(output:string)=>personDisplayEvent(sid,'run.completed',event('run.completed',{output,stop_reason:'waiting_for_tasks',waiting_for_tasks:true,background_pending:1}))!
const errors=()=>store.messages.filter(message=>message.role==='system'&&message.content.startsWith('Error:'))

async function listen(mode:'direct'|'resumed') {
  if(mode==='direct') {
    await store.sendMessage('研究后汇报')
    expect(api.start).toHaveBeenCalledTimes(1)
    return api.start.mock.calls[0][1] as (data:any)=>void
  }
  api.resume.mockImplementation((_id:any,callback:any)=>callback({session_id:sid,messages:[],messageTotal:0,isWorking:true,events:[]}))
  await store.switchSession(sid)
  const handlers=api.register.mock.calls.at(-1)![1]
  return (data:any)=>({
    'run.started':handlers.onRunStarted,
    'run.completed':handlers.onRunCompleted,
    'message.delta':handlers.onMessageDelta,
  })[data.event as 'run.started'](data)
}

it.each(['direct','resumed'] as const)('shows the projected waiting reply then the actual result without a false error (%s)',async mode=>{
  const onEvent=await listen(mode)
  onEvent(event('run.started'))
  expect(personDisplayEvent(sid,'tool.started',event('tool.started',{tool:'bot_task_create'}))).toBeNull()
  const reply='已安排研究，结果返回后我会汇总给你。'
  const payload=wait(reply)
  expect(payload).toMatchObject({output:reply,stop_reason:'waiting_for_tasks'})
  expect(payload.waiting_for_tasks).toBeUndefined()
  onEvent(payload)
  expect(store.messages.filter(message=>message.role==='assistant').map(message=>message.content)).toEqual([reply])
  expect(errors()).toEqual([])
  expect(api.bell).not.toHaveBeenCalled()

  onEvent(event('run.started',{run_id:'result-callback'}))
  onEvent(event('run.completed',{run_id:'result-callback',output:'已核查完成，这是实际结果。',background_pending:0}))
  expect(store.messages.filter(message=>message.role==='assistant').map(message=>message.content)).toEqual([reply,'已核查完成，这是实际结果。'])
  expect(errors()).toEqual([])
  expect(api.bell).toHaveBeenCalledTimes(1)
})

it.each(['direct','resumed'] as const)('accepts legacy empty waits but still reports an ordinary empty response (%s)',async mode=>{
  const onEvent=await listen(mode)
  onEvent(event('run.started'))
  onEvent(wait(''))
  expect(errors()).toEqual([])
  expect(api.bell).not.toHaveBeenCalled()

  onEvent(event('run.started',{run_id:'ordinary-empty'}))
  onEvent(event('run.completed',{run_id:'ordinary-empty',output:'',background_pending:1}))
  expect(errors()).toHaveLength(1)
  expect(errors()[0].content).toContain('Agent returned no output')
  expect(api.bell).not.toHaveBeenCalled()
})

it('preserves a streamed acknowledgement without duplicating it at waiting completion',async()=>{
  const onEvent=await listen('direct'),project=createPersonDisplayStream(sid)
  onEvent(project('run.started',event('run.started')))
  for(const delta of ['已接下任务，','结果返回后会汇报。']) {
    onEvent(project('message.delta',event('message.delta',{delta})))
  }
  onEvent(project('run.completed',event('run.completed',{output:'已接下任务，结果返回后会汇报。',stop_reason:'waiting_for_tasks'})))
  expect(store.messages.filter(message=>message.role==='assistant').map(message=>message.content)).toEqual(['已接下任务，结果返回后会汇报。'])
  expect(errors()).toEqual([])
  expect(api.bell).not.toHaveBeenCalled()
})
