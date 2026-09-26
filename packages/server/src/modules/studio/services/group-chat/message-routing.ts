import { createHash } from 'node:crypto'
import { choice, createJevSidecar, type JevSidecarAdapter, type JevSidecarTaskSpec } from '../../public/jev'
import { hashJevCanonical } from '../jev/sidecar-payload'
import type { JevSettings } from '../jev/settings'

export interface GroupRoutingCandidate { id: string; name: string; description: string }
export interface GroupRoutingMessage { id: string; roomId: string; senderId: string; senderName: string; content: string; timestamp: number; mentions?: unknown[] }
export interface GroupRoutingDecision { messageId: string; roomId: string; messageHash: string; candidateHash: string; configHash: string; targetAgentId: string | null; targetAgentName: string | null; mode: 'suggest' | 'auto'; status: 'suggested' | 'queued' | 'skipped'; queueId: string | null; confidence: number | null; createdAt: number; updatedAt: number }
export interface GroupRoutingStorage {
  getRoom(roomId: string): any
  getMessage(messageId: string): any
  getRoomAgents(roomId: string): any[]
  getMessageRoutingDecision(messageId: string): GroupRoutingDecision | null
  saveRoutingSuggestion(decision: GroupRoutingDecision): boolean
  claimAndEnqueueAutoRouting(decision: GroupRoutingDecision, requesterMemberId: string, text: string): GroupRoutingDecision | null
}

function messageHash(message: GroupRoutingMessage): string { return createHash('sha256').update(JSON.stringify({ id: message.id, roomId: message.roomId, senderId: message.senderId, content: message.content, mentions: message.mentions || [], timestamp: message.timestamp })).digest('hex') }

const adapter = (storage: GroupRoutingStorage): JevSidecarAdapter<GroupRoutingDecision, boolean> => ({
  integrationId: 'group-message-routing', policyVersion: '1', admissionCeilingMs: 30_000, maxJevCalls: 1, maxGenerationCalls: 0,
  parsePolicy: (settings: JevSettings) => ({ enabled: settings.groupMessageRoutingEnabled, budgetMs: settings.groupMessageRoutingTimeoutMs,
    policy: { minConfidence: settings.groupMessageRoutingMinConfidence } }), eligibility: () => ({ eligible: true }),
  readAuthority: async (ref, expected) => { const message=storage.getMessage(ref.object.id); const room=message&&storage.getRoom(message.roomId)
    if(!message||!room)return{allowed:false,reason:'object_deleted'}; if((room.messageRoutingMode||'off')==='off')return{allowed:false,reason:'disabled'}
    if(messageHash(message)!==expected.sourceHash)return{allowed:false,reason:'source_changed'}
    return{allowed:true} }, apply: (_ref,_expected,decision)=>storage.saveRoutingSuggestion(decision),
})

export class GroupMessageRoutingService {
  private readonly sidecar
  constructor(private readonly storage: GroupRoutingStorage, private readonly onDecision?: (decision: GroupRoutingDecision)=>void) { this.sidecar=createJevSidecar({adapters:[adapter(storage)]}) }
  schedule(message: GroupRoutingMessage, candidates: GroupRoutingCandidate[]): void {
    const room=this.storage.getRoom(message.roomId); if(!room||!['suggest','auto'].includes(room.messageRoutingMode)||candidates.length===0||message.mentions?.length)return
    const messageHashValue=messageHash(message)
    const candidateHash=hashJevCanonical(candidates.map(item=>({id:item.id,name:item.name,description:item.description})))
    const state={message:{content:message.content,sender:message.senderName},candidates:candidates.map(item=>({...item}))}; const inputHash=hashJevCanonical({messageHash:messageHashValue,candidateHash})
    const expected={sourceKey:message.id,sourceHash:messageHashValue,candidateHash}
    const task:JevSidecarTaskSpec<GroupRoutingDecision,boolean>={integrationId:'group-message-routing',sourceKey:message.id,attemptId:inputHash,createdAt:Date.now(),input:state,
      identity:{actor:{type:'room-member',id:message.senderId},authority:{type:'room-profile',id:String(room.evaluationProfile||room.summaryProfile)},profile:String(room.evaluationProfile||room.summaryProfile),object:{type:'group-message',id:message.id}},expected,
      run:async ctx=>{const snapshot=await ctx.snapshot();if(snapshot.kind!=='completed')return;const options=Object.fromEntries([...candidates.map(item=>[item.id,item.description||item.name]),['none','No suitable Agent or no action needed']]);const result=await ctx.evaluate(snapshot.value,{state,questions:{target:choice('Choose one supplied Agent id only when the message is an actionable task clearly matching its declared responsibility. Otherwise choose none.',options)}},expected);if(result.kind!=='completed')return;const answer:any=result.value.answers.target;const confidence=Number(answer?.confidence||0);const candidate=candidates.find(item=>item.id===answer?.choice);const min=Number(snapshot.value.policy.minConfidence||.9);const target=confidence>=min?candidate:undefined;let decision:GroupRoutingDecision={messageId:message.id,roomId:message.roomId,messageHash:messageHashValue,candidateHash,configHash:snapshot.value.configHash,targetAgentId:target?.id||null,targetAgentName:target?.name||null,mode:room.messageRoutingMode,status:target?'suggested':'skipped',queueId:null,confidence:Number.isFinite(confidence)?confidence:null,createdAt:Date.now(),updatedAt:Date.now()}
        if(target&&room.messageRoutingMode==='auto'){const claimed=this.storage.claimAndEnqueueAutoRouting(decision,message.senderId,message.content);if(claimed)decision=claimed;else return}else{const saved=await ctx.apply(expected,decision);if(saved.kind!=='completed'||!saved.value)return}this.onDecision?.(decision)},}
    this.sidecar.trySchedule(task)
  }
}
