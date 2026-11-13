import type { SceneTemplate } from './scene-templates'
import { REPORT_TITLE_INSTRUCTION } from './scene-templates'
import { parseAnalysisRound, type AnalysisRound } from './report-parser'
import { createPrimaryAgentBridge, type PrimaryAgentBridgeOutput as AgentBridgeOutput } from '../../public/chat-agent-runtime'

/**
 * Standalone Agent 调用（拆分自 realtime-assist.ts，行为保持一致）。
 *
 * 这里聚集所有"经过 Hermes Agent bridge"的路径：实时批次的 Agent 分析
 * （当前直调快路径的备选）与报告生成的 Agent 主路径。bridge 通过
 * `createBridge` 依赖注入，便于单测替换假实现；默认实现做动态 import，
 * 与拆分前完全一致（不把 bridge client 拉进本模块的启动依赖图）。
 */

/** bridge client 的最小结构（结构化自 AgentBridgeClient，便于测试注入假实现）。 */
export type MeetingAgentBridge = {
  chat(...args: any[]): Promise<{ run_id: string }>
  streamOutput(runId: string, options: { timeoutMs: number }): AsyncIterable<AgentBridgeOutput>
  destroy(sessionId: string, profile?: string): Promise<unknown>
}

export interface AgentBridgeDeps {
  createBridge?: () => Promise<MeetingAgentBridge> | MeetingAgentBridge
}

async function defaultCreateBridge(): Promise<MeetingAgentBridge> {
  return createPrimaryAgentBridge({ connectRetryMs: 1500 }) as MeetingAgentBridge
}

/**
 * 各场景下触发 Agent + MCP 工具查询的关键词正则。
 * 匹配到这些信号说明对话涉及需要查询核实的专业内容，值得走慢路径。
 * 未列出的场景（如 general）始终走快速直调路径。
 */
const SCENE_TOOL_TRIGGER: Record<string, RegExp> = {
  legal: /第[\d一二三四五六七八九十百千]+条|第[\d一二三四五六七八九十百千]+款|民法典|刑法|劳动法|合同法|公司法|婚姻法|继承法|物权法|侵权法|司法解释|行政法规|部门规章|地方性法规|诉讼时效|追诉时效|仲裁时效|违约金|赔偿金|经济补偿|劳动报酬|知识产权|专利权|商标权|著作权|担保|抵押|质押|留置|不可抗力|情势变更|正当防卫|紧急避险/,
  business: /合同条款|违约责任|保密协议|竞业禁止|独家代理|排他性|对赌|估值|市盈率|净利润|营收|毛利率|报价|底价|市场价|行业规范|招投标|政府采购|反垄断|商业贿赂|尽职调查|审计|税务|发票|税率/,
  medical: /禁忌|不良反应|相互作用|配伍禁忌|剂量|用量|毫克|mg|毫升|ml|指南|共识|禁忌证|适应证|耐药|过敏|肝肾功能|孕妇|哺乳|儿童用药|药物相互作用|半衰期|血药浓度/,
}

/**
 * 判断当前对话内容是否需要走 Agent + MCP 工具路径。
 * 根据场景查找对应的触发正则，未配置的场景始终走快速路径。
 */
export function needsToolLookup(sceneTemplateId: string, transcriptText: string): boolean {
  const re = SCENE_TOOL_TRIGGER[sceneTemplateId]
  if (!re) return false
  return re.test(transcriptText)
}

/**
 * 判断一段文本是不是 agent 优雅失败的产物。外部 `agent` Python 包在
 * provider 错误时（如 OpenAI SDK 抛 "Provider returned an empty stream with
 * no finish_reason"）通常会写一段 ≤2000 字符的 final_response（典型形如
 * "API call failed after 3 retries: ..."），而不是让 run_conversation 抛
 * 异常。这种情况下 record.status 仍是 'complete'，需要从内容本身判断。
 *
 * 借鉴 packages/server/src/services/hermes/run-chat/handle-bridge-run.ts
 * 的 looksLikeStandaloneAgentFailure。后续可提取到独立模块共享，本轮先本地
 * 复刻，避免跨域改动扩大 blast radius。
 */
export function looksLikeStandaloneAgentFailure(value: string): boolean {
  const text = value.replace(/\s+/g, ' ').trim()
  if (!text) return false
  // 报告通常远大于 2 KB，agent 失败短消息一般 ≤ 2 KB（与 handle-bridge-run 保持一致）
  if (text.length > 2_000) return false
  return (
    /\bAPI call failed after\b/i.test(text)
    || /\bHTTP\s+(?:4\d\d|5\d\d)\b/i.test(text)
    || /\bProvider returned an empty stream\b/i.test(text)
    || /\b(?:401|403)\b.{0,100}\b(?:unauthorized|forbidden|authentication|auth|invalid api key|permission denied)\b/i.test(text)
    || /\b(?:unauthorized|forbidden|authentication|auth|invalid api key|permission denied)\b.{0,100}\b(?:401|403)\b/i.test(text)
    || /\b429\b.{0,100}\b(?:rate limit|too many requests|quota)\b/i.test(text)
    || /\b(?:rate limit|too many requests|quota)\b.{0,100}\b429\b/i.test(text)
    || /\b(?:500|502|503|504)\b.{0,100}\b(?:server error|bad gateway|service unavailable|gateway timeout|upstream|provider|request failed|api)\b/i.test(text)
    || /\b(?:server error|bad gateway|service unavailable|gateway timeout|upstream|provider|request failed|api)\b.{0,100}\b(?:500|502|503|504)\b/i.test(text)
    || /(?:无可用渠道|渠道不可用|认证失败|鉴权失败|额度不足|余额不足|请求失败|接口调用失败)/i.test(text)
    || /(?:请求|接口|模型|渠道|API).{0,20}(?:被限流|触发限流|因限流失败)/i.test(text)
    || /(?:限流|频率限制).{0,20}(?:失败|错误|重试|稍后)/i.test(text)
  )
}

/**
 * 经过 Hermes Agent 进行实时分析，可调用 MCP 工具（如法规查询）。
 * 20s 超时限制，超时或 bridge 不可用时由上层回退到直调 LLM。
 */
export async function runAgentAnalysis(
  transcriptText: string,
  template: SceneTemplate,
  profile: string,
  deps?: AgentBridgeDeps,
): Promise<AnalysisRound | null> {
  const bridge = deps?.createBridge ? await deps.createBridge() : await defaultCreateBridge()
  const agentSessionId = `meeting-analyze-${Date.now()}`

  try {
    const started = await bridge.chat(
      agentSessionId,
      `以下是最近的对话内容：\n\n${transcriptText}`,
      undefined,
      template.systemPrompt,
      profile,
      { source: 'meeting-asr' },
    )

    let finalText = ''
    for await (const chunk of bridge.streamOutput(started.run_id, { timeoutMs: 20_000 })) {
      if (chunk.delta) finalText += chunk.delta
      if (chunk.done) {
        // 部分 bridge 不增量返回 delta，从 result 提取
        if (!finalText.trim()) {
          const result = chunk.result as { final_response?: string } | undefined
          finalText = result?.final_response || chunk.output || ''
        }
        break
      }
      if (chunk.status === 'error') {
        throw new Error(chunk.error || 'Agent analysis run failed')
      }
    }

    if (!finalText.trim()) throw new Error('Agent analysis produced no output')
    return parseAnalysisRound(finalText)
  } finally {
    void bridge.destroy(agentSessionId, profile).catch(() => {})
  }
}

/**
 * 经过 Hermes Agent bridge 生成报告，复用用户训练好的 profile（系统提示词 / 技能 / 记忆）。
 * 场景的 reportPrompt 作为任务级 instructions 叠加在用户 agent 之上。
 */
export async function* streamAgentReport(
  sessionId: string,
  transcript: string,
  template: SceneTemplate,
  profile: string,
  deps?: AgentBridgeDeps,
): AsyncGenerator<string> {
  // 较短的连接重试窗口：bridge 不可用时快速失败，便于上层回退到直调 LLM。
  const bridge = deps?.createBridge ? await deps.createBridge() : await defaultCreateBridge()
  const agentSessionId = `meeting-report-${sessionId}`

  try {
    const started = await bridge.chat(
      agentSessionId,
      `以下是完整的会议转写内容：\n\n${transcript}`,
      undefined,
      `${template.reportPrompt}\n\n${REPORT_TITLE_INSTRUCTION}`,
      profile,
      { source: 'meeting-asr' },
    )

    let lastChunk: AgentBridgeOutput | null = null
    let yieldedAny = false
    // 累计本次 run 已经看到的所有 delta 文本，用来检查末态是不是 agent
    // 优雅失败的产物——外部 `agent` 包在 provider 错误时会写一段形如
    // "API call failed after 3 retries: ..." 的 final_response，而不是抛
    // 异常。这种情况下 record.status = 'complete'（不是 'error'），
    // 旧的 status 检查抓不到，但用户看到的依然是错误文本。借鉴
    // handle-bridge-run.ts 的 looksLikeStandaloneAgentFailure 思路检测并抛错。
    let accumulatedDelta = ''
    for await (const chunk of bridge.streamOutput(started.run_id, { timeoutMs: 180_000 })) {
      lastChunk = chunk
      if (chunk.delta) {
        accumulatedDelta += chunk.delta
        // 流末尾的最终一段 delta 才有可能是"假完成"信号；中途的 delta 不算
        // （agent 可能在解释它为什么失败，但仍有可能真出过内容）。
        if (chunk.done && looksLikeStandaloneAgentFailure(accumulatedDelta)) {
          throw new Error(accumulatedDelta.trim() || 'Agent reported provider failure')
        }
        yieldedAny = true
        yield chunk.delta
      } else if (chunk.done) {
        // 没有 delta 但 done：典型情况是 agent 整体失败（status=error），
        // 真正的错误信息在 lastChunk.error 里。
        if (chunk.status === 'error') {
          throw new Error(chunk.error || 'Agent report run failed')
        }
        // 既有 done 又无 delta 且状态非 error：当作 no-output 处理（下方
        // yieldedAny 分支会兜底）。
        break
      }
    }

    // 兜底：本次 run 没有 stream 出任何 delta，从 result.final_response 提取。
    // 该路径同样要避开 agent-failure 的"假完成"内容，否则会把错误信息当报告 yield 出去。
    if (!yieldedAny) {
      const result = lastChunk?.result as { final_response?: string } | undefined
      const finalText = (result?.final_response || lastChunk?.output || '').trim()
      if (!finalText) throw new Error('Agent report produced no output')
      if (looksLikeStandaloneAgentFailure(finalText)) {
        throw new Error(finalText)
      }
      yield finalText
    }
  } finally {
    // 报告生成是一次性场景，结束后立即销毁临时会话，避免占用 bridge 资源。
    void bridge.destroy(agentSessionId, profile).catch(() => {})
  }
}
