import { createApp, h, provide, ref } from 'vue'
import { createI18n } from 'vue-i18n'
import PersonTaskActivity from '../../../packages/client/src/components/hermes/person/PersonTaskActivity.vue'
import PersonTaskReturnCard from '../../../packages/client/src/components/hermes/person/PersonTaskReturnCard.vue'
import { personTaskNavigation } from '../../../packages/client/src/components/hermes/person/task-navigation'
import zh from '../../../packages/client/src/i18n/locales/zh'
import type { PersonTask, PersonTaskReturn } from '../../../packages/client/src/api/person'
import '../../../packages/client/src/styles/global.scss'

const development: PersonTask = {
  id: 'original-development', session_id: 'person-main-chef', title: 'Codex 登录页', summary: '', status: 'completed', revision: 5,
  execution_id: 'development-execution', execution_state: 'finished', running: true,
  selection_json: JSON.stringify({ runtime: 'codex' }), completion_evidence: 'Accepted by reviewer', updated_at: 1,
}
const verifier: PersonTask = { ...development, id: 'independent-verification', title: '验收：Codex 登录页', execution_id: 'verification-execution',
  status: 'open', execution_state: 'running', activity_running: true }
const receipt = ref<PersonTaskReturn | null>(JSON.parse(localStorage.getItem('acceptance-return') || 'null'))
const tasks = ref<PersonTask[]>(receipt.value ? [] : [development])
const opened = ref<{taskId: string; executionId?: string} | null>(null)
const openTask = (taskId: string, executionId?: string) => { opened.value = {taskId, executionId} }
;(window as any).taskReturnActivityFixture = {
  delivered() { tasks.value = [] },
  verifying() { tasks.value = [{...development,status:'open',activity_running:false},verifier] },
  accepted() {
    tasks.value = []
    receipt.value = {taskId:development.id,executionId:development.execution_id!,assistantMessageId:'final-message',title:development.title,
      summary:'已交付可运行的登录页',agent:'codex',state:'finished',relatedTasks:[{
        taskId:verifier.id,executionId:verifier.execution_id!,assistantMessageId:'final-message',title:verifier.title,
        summary:'验收通过，已保存检查证据',agent:'codex',state:'finished',
      }]}
    localStorage.setItem('acceptance-return',JSON.stringify(receipt.value))
  },
}
const app = createApp({ setup() {
  provide(personTaskNavigation,openTask)
  return () => h('main', { style: { position: 'relative', height: '100vh' } }, [
    h(PersonTaskActivity, { sessionId: 'person-main-chef', count: 0,
      agentCount: tasks.value.filter(task=>task.activity_running ?? task.running).length, tasks: tasks.value, flows: [], name: '大厨',
      onOpenTask: (task: PersonTask) => openTask(task.id,task.execution_id || undefined),
    }),
    receipt.value ? h(PersonTaskReturnCard,{result:receipt.value}) : null,
    opened.value ? h('output', { 'aria-label': '打开的任务', style: { position: 'absolute', top: '280px' } }, JSON.stringify(opened.value)) : null,
  ])
} })
app.use(createI18n({ legacy: false, locale: 'zh', messages: { zh } }))
app.mount('#app')
