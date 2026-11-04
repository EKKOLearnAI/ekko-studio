import { createApp, h, ref, nextTick } from 'vue'
import { NConfigProvider, darkTheme } from 'naive-ui'
import { createI18n } from 'vue-i18n'
import PersonFlowCard from '../../../packages/client/src/components/hermes/person/PersonFlowCard.vue'
import { personMessages } from '../../../packages/client/src/i18n/person-messages'
import type { PersonFlow } from '../../../packages/client/src/api/person'
import '../../../packages/client/src/styles/global.scss'

const flow = ref<PersonFlow>({
  id:'idiom-chain',creator_session_id:'person-main-creator',title:'成语接龙',goal:'各 Bot 依次接龙三轮',state:'active',revision:1,current_position:0,error:'',round_number:2,round_limit:3,
  stages:['甲','乙'].map((name,index)=>({id:`stage-${index}`,position:index,group_position:index,session_id:`person-main-${index}`,session_title:name,
    goal:'接上一个成语',state:index ? 'pending' : 'active',result_message_id:null,tasks:[]})),
})
const dark = ref(false)
const action = ref('')
const result = ref('')
const saving = ref(false)
;(window as any).flowRoundsFixture = {
  report(state:NonNullable<PersonFlow['completion_report']>['state']) {
    flow.value.state='completed';flow.value.round_number=3;flow.value.stages.forEach(stage=>{stage.state='completed'})
    flow.value.completion_report={id:'report-1',state,attempts:5,attempt_limit:5,run_id:'report-run',result_message_id:state==='delivered'?777:null,error:state==='failed'?'Fixture summary delivery failure':'',next_attempt_at:0}
  },
  saving(value:boolean) {saving.value=value},
  continuous() {flow.value.round_limit=0},
  nextRound() {flow.value.round_number=3},
  completed() {flow.value.state='completed';flow.value.stages.forEach(s=>{s.state='completed'})},
  confirming() {flow.value.stages[0].result_message_id=16125;flow.value.stages[0].confirmation={state:'confirming',attempts:1,reason:'',message_id:16125}},
  blocked() {
    flow.value.state='failed';flow.value.error='确认失败：需要补充输入'
    flow.value.stages[0].state='failed'
    flow.value.stages[0].confirmation={state:'blocked',attempts:2,reason:flow.value.error,message_id:16125}
  },
  theme(value=true) {dark.value=value;document.documentElement.classList.toggle('dark',value);return nextTick()},
}
createApp({setup:()=>()=>h(NConfigProvider,{theme:dark.value?darkTheme:null},()=>h('main',{style:{maxWidth:'1000px',margin:'20px auto'}},[
  h(PersonFlowCard,{flow:flow.value,saving:saving.value,onAction:(_flow:PersonFlow,value:'stop'|'resume'|'retry_report')=>{
    if(value==='retry_report') {action.value=value;flow.value.completion_report={...flow.value.completion_report!,state:'pending',attempt_limit:10,error:''};return}
    action.value=value;flow.value.state=value==='stop'?'stopped':'active'
    if(value==='resume' && flow.value.stages[0].confirmation){flow.value.error='';flow.value.stages[0].state='active';flow.value.stages[0].confirmation={...flow.value.stages[0].confirmation,state:'pending',attempts:0,reason:''}}
  },onOpenResult:(sessionId:string,messageId:number)=>{result.value=`${sessionId}:${messageId}`}}),
  h('output',{'aria-label':'流程操作'},action.value),
  h('output',{'aria-label':'原回复'},result.value),
]))}).use(createI18n({legacy:false,locale:'zh',messages:{zh:{person:personMessages.zh}}})).mount('#app')
