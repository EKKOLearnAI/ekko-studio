import {createApp,h} from 'vue'
import {createPinia} from 'pinia'
import {createI18n} from 'vue-i18n'
import SessionListItem from '../../../packages/client/src/components/hermes/chat/SessionListItem.vue'
import {useSessionStateStore} from '../../../packages/client/src/stores/hermes/session-state'
import type {Session} from '../../../packages/client/src/stores/hermes/chat'
import zh from '../../../packages/client/src/i18n/locales/zh'
import '../../../packages/client/src/styles/global.scss'

const id='person-main-presence-fixture'
const session={id,title:'樱樱',profile:'default',source:'builtin_agent',agent:'ekko-agent',bot_type:'yingying',createdAt:Date.now()} as Session
createApp({setup(){
  const states=useSessionStateStore();states.start()
  const update=(working:boolean,backgroundPending=0)=>(window as any).presenceTransport.update({sessionId:id,profile:'default',working,backgroundPending,lastMessageId:0,readMessageId:0,unread:false})
  return()=>h('main',{},[
    // Deliberately stale chat-store fallback: an authoritative snapshot wins.
    h(SessionListItem,{session,active:false,pinned:false,canDelete:false,showProfile:false,showTime:false,streaming:states.isWorking(id,true)}),
    h('button',{onClick:()=>update(false)},'停止后的状态'),
    h('button',{onClick:()=>update(true)},'真实新运行'),
    h('button',{onClick:()=>update(true,1)},'后台仍有任务'),
  ])
}}).use(createPinia()).use(createI18n({legacy:false,locale:'zh',messages:{zh}})).mount('#app')
