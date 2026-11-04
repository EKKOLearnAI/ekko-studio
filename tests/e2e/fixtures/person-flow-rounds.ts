import { createApp, h, ref, nextTick } from 'vue'
import { NConfigProvider, darkTheme } from 'naive-ui'
import { createI18n } from 'vue-i18n'
import PersonFlowCard from '../../../packages/client/src/components/hermes/person/PersonFlowCard.vue'
import { personMessages } from '../../../packages/client/src/i18n/person-messages'
import type { PersonFlow } from '../../../packages/client/src/api/person'
import '../../../packages/client/src/styles/global.scss'

const flow = ref<PersonFlow>({
  id:'idiom-chain',title:'成语接龙',goal:'各 Bot 依次接龙三轮',state:'active',revision:1,current_position:0,error:'',round_number:2,round_limit:3,
  stages:['甲','乙'].map((name,index)=>({id:`stage-${index}`,position:index,group_position:index,session_id:`person-main-${index}`,session_title:name,
    goal:'接上一个成语',state:index ? 'pending' : 'active',result_message_id:null,tasks:[]})),
})
const dark = ref(false)
const action = ref('')
const result = ref('')
;(window as any).flowRoundsFixture = {
  continuous() {flow.value.round_limit=0},
  nextRound() {flow.value.round_number=3},
  completed() {flow.value.state='completed';flow.value.stages.forEach(s=>{s.state='completed'})},
  confirming() {flow.value.stages[0].result_message_id=16125;flow.value.stages[0].confirmation={state:'confirming',attempts:1,reason:'',message_id:16125}},
  blocked() {
    flow.value.state='failed';flow.value.error='确认失败：需要补充输入'
    flow.value.stages[0].state='failed'
    flow.value.stages[0].confirmation={state:'blocked',attempts:2,reason:flow.value.error,message_id:16125}
  },
  theme() {dark.value=true;document.documentElement.classList.add('dark');document.documentElement.style.setProperty('--theme-card-alpha','0.3');return nextTick()},
}
createApp({setup:()=>()=>h(NConfigProvider,{theme:dark.value?darkTheme:null},()=>h('main',{style:{maxWidth:'1000px',margin:'20px auto'}},[
  h(PersonFlowCard,{flow:flow.value,saving:false,onAction:(_flow:PersonFlow,value:'stop'|'resume')=>{
    action.value=value;flow.value.state=value==='stop'?'stopped':'active'
    if(value==='resume' && flow.value.stages[0].confirmation){flow.value.error='';flow.value.stages[0].state='active';flow.value.stages[0].confirmation={...flow.value.stages[0].confirmation,state:'pending',attempts:0,reason:''}}
  },onOpenResult:(sessionId:string,messageId:number)=>{result.value=`${sessionId}:${messageId}`}}),
  h('output',{'aria-label':'流程操作'},action.value),
  h('output',{'aria-label':'原回复'},result.value),
]))}).use(createI18n({legacy:false,locale:'zh',messages:{zh:{person:personMessages.zh}}})).mount('#app')
