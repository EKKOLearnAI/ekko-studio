// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import Activity from '@/components/hermes/person/PersonTaskActivity.vue'
vi.mock('vue-i18n',()=>({useI18n:()=>({t:(key:string)=>key,locale:ref('en')})}))
vi.mock('@/composables/usePageLoading',()=>({usePageLoadingState:()=>ref(false)}))
vi.mock('@/utils/chat-agent-avatar',()=>({PERSON_AVATAR:{label:'Bot',src:'/bot.png'},PERSON_ANIMATIONS:{searching:'/search.gif',done:'/done.gif',error:'/error.gif',thinking:'/think.gif'},personAvatarAnimation:()=>undefined}))
let wrapper: ReturnType<typeof mount>
beforeEach(()=>{vi.useFakeTimers();vi.stubGlobal('matchMedia',()=>({matches:true,addEventListener(){},removeEventListener(){}}))})
afterEach(()=>{wrapper?.unmount();vi.useRealTimers();vi.unstubAllGlobals()})
it('expands in place and routes task selection without opening all tasks',async()=>{
 const onTask = vi.fn()
 wrapper=mount(Activity,{props:{onTask,count:1,tasks:[{id:'a',title:'Run test',status:'open',execution_state:'running'} as any]},attachTo:document.body})
 await wrapper.get('.person-task-island').trigger('click')
 expect(wrapper.find('.activity-content').exists()).toBe(true)
 expect(wrapper.emitted('open')).toBeUndefined()
 await wrapper.get('.activity-row').trigger('click');await vi.advanceTimersByTimeAsync(400)
 expect(onTask).toHaveBeenCalledExactlyOnceWith('a')
 expect(wrapper.get('img').attributes('src')).toBe('/bot.png')
})
it('shows completion briefly and cancels it on new work',async()=>{
 wrapper=mount(Activity,{props:{count:1,tasks:[{id:'a',status:'open',execution_state:'running'} as any]}})
 await wrapper.setProps({count:0,tasks:[]});await wrapper.get('.person-task-island').trigger('click');expect(wrapper.text()).toContain('person.states.finished')
 await wrapper.setProps({count:1,tasks:[{id:'b',status:'open',execution_state:'running'} as any]});await vi.advanceTimersByTimeAsync(4000)
 expect(wrapper.find('.person-task-island').exists()).toBe(true)
})
it('collapses on outside interaction without moving focus',async()=>{
 wrapper=mount(Activity,{props:{count:1,tasks:[{id:'a',status:'open',execution_state:'running'} as any]},attachTo:document.body});await wrapper.get('button').trigger('click')
 document.body.dispatchEvent(new Event('pointerdown',{bubbles:true}));await wrapper.vm.$nextTick()
 expect(wrapper.get('button').attributes('aria-expanded')).toBe('false')
})
it('queues individual completions while other tasks remain active and does not replay snapshots',async()=>{
 const a={id:'a',title:'First',status:'open',execution_state:'running',execution_id:'run-a'} as any
 const b={id:'b',title:'Second',status:'open',execution_state:'running',execution_id:'run-b'} as any
 wrapper=mount(Activity,{props:{count:2,tasks:[a,b]}})
 await wrapper.setProps({count:1,tasks:[{...a,status:'completed',execution_state:'finished'},b]})
 expect(wrapper.find('.activity-completion').text()).toContain('First')
 await wrapper.setProps({tasks:[{...a,status:'completed',execution_state:'finished'},b]})
 await vi.advanceTimersByTimeAsync(3500)
 expect(wrapper.find('.activity-completion').exists()).toBe(false)
})
it('does not replay initial completions and clears feedback on session change',async()=>{
 const task={id:'a',title:'First',status:'completed',execution_state:'finished'} as any
 wrapper=mount(Activity,{props:{count:0,scope:'one',tasks:[task]}})
 expect(wrapper.find('.activity-completion').exists()).toBe(false)
 await wrapper.setProps({count:1,tasks:[{...task,status:'open',execution_state:'running'}]})
 await wrapper.setProps({count:0,tasks:[task]})
 expect(wrapper.find('.activity-completion').exists()).toBe(true)
 await wrapper.setProps({scope:'two',tasks:[task]});await vi.advanceTimersByTimeAsync(400)
 expect(wrapper.find('.activity-completion').exists()).toBe(false)
})
it('shows simultaneous completions one by one without dropping the second',async()=>{
 const tasks=['a','b'].map(id=>({id,title:id,status:'open',execution_state:'running'} as any))
 wrapper=mount(Activity,{props:{count:2,tasks}})
 await wrapper.setProps({count:0,tasks:tasks.map(t=>({...t,status:'completed',execution_state:'finished'}))})
 expect(wrapper.find('.activity-completion').text()).toContain('a')
 await vi.advanceTimersByTimeAsync(3500)
 expect(wrapper.find('.activity-completion').text()).toContain('b')
 await vi.advanceTimersByTimeAsync(3500)
 expect(wrapper.find('.activity-completion').exists()).toBe(false)
})
it('uses each task session BOT identity rather than the current capsule avatar', async()=>{
 wrapper=mount(Activity,{props:{count:2,tasks:[{id:'a',title:'Crane',bot_type:'xiaohe',status:'open',execution_state:'running'},{id:'b',title:'Chef',bot_type:'dachu',status:'open',execution_state:'pending'}] as any}})
 await wrapper.get('.person-task-island').trigger('click')
 const images=wrapper.findAll('.activity-row img').map(image=>image.attributes('src'))
 expect(images[0]).toContain('/person/xiaohe/idle.png')
 expect(images[1]).toContain('/person/dachu/idle.png')
})

it('ignores stale presence counts and removes the empty capsule after completion feedback', async()=>{
 const task={id:'a',title:'Task',status:'open',execution_state:'running'} as any
 wrapper=mount(Activity,{props:{count:1,tasks:[task]}})
 await wrapper.get('.person-task-island').trigger('click')
 await wrapper.setProps({tasks:[{...task,status:'completed',execution_state:'finished'}]})
 expect(wrapper.get('.person-task-island').attributes('aria-label')).toContain('person.backgroundTasks · 0')
 expect(wrapper.find('.activity-completion').exists()).toBe(true)
 await vi.advanceTimersByTimeAsync(4000)
 expect(wrapper.find('.person-task-island').exists()).toBe(false)
})
