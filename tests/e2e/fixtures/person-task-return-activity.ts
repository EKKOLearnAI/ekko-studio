import { createApp, h, ref } from 'vue'
import { createI18n } from 'vue-i18n'
import PersonTaskActivity from '../../../packages/client/src/components/hermes/person/PersonTaskActivity.vue'
import { personMessages } from '../../../packages/client/src/i18n/person-messages'
import type { PersonTask } from '../../../packages/client/src/api/person'
import '../../../packages/client/src/styles/global.scss'

const tasks = ref<PersonTask[]>([{
  id: 'original-development', session_id: 'person-main-chef', title: 'Codex 登录页', summary: '', status: 'completed', revision: 5,
  execution_id: 'development-execution', execution_state: 'finished', running: true,
  selection_json: JSON.stringify({ runtime: 'codex' }), completion_evidence: 'Accepted by reviewer', updated_at: 1,
}])
const opened = ref<PersonTask | null>(null)
;(window as any).taskReturnActivityFixture = { delivered() { tasks.value = [] } }
const app = createApp({ setup: () => () => h('main', { style: { position: 'relative', height: '100vh' } }, [
  h(PersonTaskActivity, { sessionId: 'person-main-chef', count: 0, agentCount: tasks.value.length, tasks: tasks.value, flows: [], name: '大厨',
    onOpenTask: (task: PersonTask) => { opened.value = task },
  }),
  opened.value ? h('output', { 'aria-label': '打开的任务', style: { position: 'absolute', top: '180px' } }, JSON.stringify({ taskId: opened.value.id, executionId: opened.value.execution_id })) : null,
]) })
app.use(createI18n({ legacy: false, locale: 'zh', messages: { zh: { person: personMessages.zh } } }))
app.mount('#app')
