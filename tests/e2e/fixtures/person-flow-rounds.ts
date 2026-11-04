import { createApp, h, ref } from 'vue'
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
const action = ref('')
;(window as any).flowRoundsFixture = {
  continuous() {flow.value.round_limit=0},
  nextRound() {flow.value.round_number=3},
  completed() {flow.value.state='completed';flow.value.stages.forEach(s=>{s.state='completed'})},
}
createApp({setup:()=>()=>h('main',{style:{maxWidth:'1000px',margin:'20px auto'}},[
  h(PersonFlowCard,{flow:flow.value,saving:false,onAction:(_flow:PersonFlow,value:'stop'|'resume')=>{
    action.value=value;flow.value.state=value==='stop'?'stopped':'active'
  }}),
  h('output',{'aria-label':'流程操作'},action.value),
])}).use(createI18n({legacy:false,locale:'zh',messages:{zh:{person:personMessages.zh}}})).mount('#app')
