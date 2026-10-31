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
 wrapper=mount(Activity,{props:{count:1,tasks:[{id:'a',title:'Run test',status:'open',execution_state:'running'} as any]},attachTo:document.body})
 await wrapper.get('.person-task-island').trigger('click')
 expect(wrapper.find('.activity-content').exists()).toBe(true)
 expect(wrapper.emitted('open')).toBeUndefined()
 await wrapper.get('.activity-row').trigger('click')
 expect(wrapper.emitted('task')).toEqual([['a']])
 expect(wrapper.get('img').attributes('src')).toBe('/bot.png')
})
it('shows completion briefly and cancels it on new work',async()=>{
 wrapper=mount(Activity,{props:{count:1}})
 await wrapper.setProps({count:0});expect(wrapper.text()).toContain('person.states.finished')
 await wrapper.setProps({count:1});await vi.advanceTimersByTimeAsync(4000)
 expect(wrapper.find('.person-task-island').exists()).toBe(true)
})
it('collapses on outside interaction without moving focus',async()=>{
 wrapper=mount(Activity,{props:{count:1},attachTo:document.body});await wrapper.get('button').trigger('click')
 document.body.dispatchEvent(new Event('pointerdown',{bubbles:true}));await wrapper.vm.$nextTick()
 expect(wrapper.get('button').attributes('aria-expanded')).toBe('false')
})
