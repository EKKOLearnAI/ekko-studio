import { config } from '../../studio/public/config'
import { AgentUpdatePolicy } from './update-policy'
import { getCodingAgentDefinitions, checkUpdateAgent, installCodingAgent } from './index'
import { codingAgentRunManager } from './runtime/run-manager'
import { lockAgentUpdate, agentPreparing, agentActivityRevision } from './update-lock'
const policy = new AgentUpdatePolicy(config.appHome, {
 ids:()=>getCodingAgentDefinitions().map(v=>v.id),
 check:checkUpdateAgent,
 busy:id=>agentPreparing(id) || codingAgentRunManager.isAgentBusyForUpdate(id),
 safelyManaged:id=>id!=='cursor' && getCodingAgentDefinitions().some(agent=>agent.id===id),
 activityRevision:agentActivityRevision,
 install:async id=>{
  const release=lockAgentUpdate(id)
  try {
   if(codingAgentRunManager.isAgentBusyForUpdate(id))throw new Error('Agent session became active; update postponed')
   return await installCodingAgent(id)
  }finally{release()}
 },
})
let loaded: Promise<void>|null=null
function loadPolicy(): Promise<void> {
  if (!loaded) loaded = policy.load()
  return loaded
}
// Manual checking publishes the shared result but must not start auto-install.
export async function checkAgentUpdateAndPublish(id: string) {
  await loadPolicy()
  return policy.checkNow(id)
}
let started: Promise<void>|null=null
export async function getAgentUpdateManager():Promise<AgentUpdatePolicy>{
 if(!started)started=loadPolicy().then(()=>policy.start())
 await started;return policy
}

export async function installAgentAndPublish(id: string) {
  await loadPolicy()
  return policy.installAndRefresh(id, () => installCodingAgent(id))
}
