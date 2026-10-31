// @vitest-environment jsdom
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import Card from '@/components/hermes/person/PersonFlowCard.vue'
import type { PersonFlow } from '@/api/person'
vi.mock('vue-i18n',()=>({useI18n:()=>({t:(key:string)=>key,locale:ref('en')})}))
const flow: PersonFlow = {id:'f',title:'Flow',goal:'Goal',state:'active',revision:0,current_position:0,error:'',stages:[0,1,2].map(position=>({id:`s${position}`,position,group_position:position<2?0:1,session_id:'same-bot',session_title:'Same BOT',state:'active',goal:`Goal ${position}`,result_message_id:null,tasks:[]}))}
let wrapper: ReturnType<typeof mount>, scroll: ReturnType<typeof vi.fn>
beforeEach(()=>{vi.useFakeTimers();scroll=vi.fn();vi.stubGlobal('matchMedia',()=>({matches:false}));Object.defineProperty(HTMLElement.prototype,'scrollIntoView',{configurable:true,value:scroll})})
afterEach(()=>{wrapper?.unmount();vi.useRealTimers();vi.unstubAllGlobals();delete (HTMLElement.prototype as any).scrollIntoView})
it('focuses only the exact repeated BOT occurrence and highlights it briefly', async()=>{
 wrapper=mount(Card,{props:{flow,saving:false},attachTo:document.body})
 const target=wrapper.get('[data-flow-stage-id="s2"]')
 ;(wrapper.vm as any).focusStage('s2');await wrapper.vm.$nextTick()
 expect(document.activeElement).toBe(target.element)
 expect(scroll.mock.instances).toEqual([target.element])
 expect(scroll).toHaveBeenCalledExactlyOnceWith({block:'center',inline:'nearest',behavior:'smooth'})
 expect(wrapper.findAll('.flow-role--targeted')).toHaveLength(1)
 await wrapper.setProps({flow:{...flow,revision:1}})
 expect(scroll).toHaveBeenCalledTimes(1)
 await vi.advanceTimersByTimeAsync(2500)
 expect(wrapper.find('.flow-role--targeted').exists()).toBe(false)
 ;(wrapper.vm as any).focusStage('s2');await wrapper.vm.$nextTick()
 expect(scroll).toHaveBeenCalledTimes(2)
 expect(target.classes()).toContain('flow-role--targeted')
})
it('handles reduced motion and stale stage IDs without choosing a different BOT', async()=>{
 vi.stubGlobal('matchMedia',()=>({matches:true}))
 wrapper=mount(Card,{props:{flow,saving:false},attachTo:document.body})
 ;(wrapper.vm as any).focusStage('s1');await wrapper.vm.$nextTick()
 expect(scroll).toHaveBeenLastCalledWith({block:'center',inline:'nearest',behavior:'instant'})
 ;(wrapper.vm as any).focusStage('missing');await wrapper.vm.$nextTick()
 expect(document.activeElement).toBe(wrapper.element)
 expect(wrapper.find('.flow-role--targeted').exists()).toBe(false)
 expect(scroll).toHaveBeenLastCalledWith({block:'start',inline:'nearest',behavior:'instant'})
 wrapper.unmount();await vi.advanceTimersByTimeAsync(2500)
 expect(scroll).toHaveBeenCalledTimes(2)
})
