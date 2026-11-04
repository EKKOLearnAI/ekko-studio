import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { NConfigProvider, NMessageProvider, NDialogProvider } from 'naive-ui'
import PersonTaskChat from '../../../packages/client/src/components/hermes/person/PersonTaskChat.vue'
import { i18nReady } from '../../../packages/client/src/i18n'
import '../../../packages/client/src/styles/global.scss'

const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',component:{render:()=>null}}]})
await router.push('/')
const app=createApp({render:()=>h(NConfigProvider,{}, {default:()=>h(NMessageProvider,{}, {default:()=>h(NDialogProvider,{}, {default:()=>h('main',{style:{display:'flex',height:'100vh',width:'100vw',justifyContent:'flex-end'}},[
  h(PersonTaskChat,{taskId:'fixture-task',mainSessionId:'person-main-fixture'}),
])})})})})
app.use(createPinia()); app.use(await i18nReady); app.use(router)
await router.isReady(); app.mount('#app')
