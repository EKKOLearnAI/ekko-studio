/**
 * Prompt assembly for the group-chat document pipeline (reading + aggregation).
 * Spec: docs/planning/group-chat-large-doc-pipeline-spec.md §2 / §4.
 *
 * The reading layer is a mechanical pipeline, not free discussion: each round
 * the model gets a fixed system instruction + the current chunk + the agent's
 * rolling volume summary, and must return a strict JSON fact array.
 */
import type { GcDocumentFieldRow } from '../../repositories/document-store'

export const VOLUME_SIZE = 10 // chunks per volume summary

export const DOCUMENT_REPORT_TOOL_NAME = 'document_report'

const READING_SYSTEM_PROMPT = `你是法律文档精读助手。你只做语义提取与字段核对，不做摘要概括、不输出感想。
对给定的"当前块"，逐项输出结构化事实（JSON），规则如下：
- 只输出一个 JSON 数组（纯文本，不要 markdown 代码块），元素格式：
  {"type": "义务|风险|事实|交叉引用|冲突", "content": "中文陈述", "quote": "原文中支撑这句话的最小片段", "cross_refs": ["引用的其他条款/章节号（没有则空数组）"]}
- quote 必须是当前块中逐字存在的片段，禁止改写或推测。
- 若"待核对字段"中存在与当前块原文不符的条目，输出一条 {"type":"冲突","content":"字段值X与原文Y不符",...}。
- 只输出 JSON，不要任何前后缀文字。`

const READING_USER_PROMPT = `文件类型：{docType}
待核对字段（程序化规则提取，若与原文不符请标记冲突）：
{fieldsJson}

当前卷摘要（此前块的精读结论，供延续逻辑，不要重复输出已覆盖内容）：
{volumeSummary}

当前块（第 {chunkIndex}/{chunkTotal} 块）：
{chunkText}

输出该块的 fact JSON 数组：`

const VOLUME_SYSTEM_PROMPT = `你是法律文档卷摘要助手。把给定的一批精读事实压缩成一份卷摘要。
要求：
- 保留义务/风险/交叉引用/冲突，去掉重复与琐碎细节。
- 纯文本输出，中文，≤400字。不要 JSON，不要列表符号外的结构。`

const VOLUME_USER_PROMPT = `以下是一批精读事实 JSON（按块分组），请压缩为卷摘要：
{factsJson}

卷摘要：`

const AGGREGATE_LEVEL1_SYSTEM_PROMPT = `你是法律文档卷终稿助手。把本 agent 的全部卷摘要与规则字段合并成一份"卷终稿摘要"。
要求：
- 覆盖：义务、风险、关键金额/日期/当事人、法条引用、交叉引用、冲突。
- 纯文本中文输出，≤1500字，使用简洁列表。
- 冲突条目明确标注"待核实"。`

const AGGREGATE_LEVEL1_USER_PROMPT = `文件类型：{docType}
规则字段（本卷范围内）：
{fieldsJson}

全部卷摘要：
{volumesJson}

卷终稿摘要：`

const AGGREGATE_LEVEL2_SYSTEM_PROMPT = `你是资深律师主持。你有 N 位精读助手各自完成的"卷终稿摘要"，请交叉核对并产出终稿。
终稿必须包含四个部分（用标题分隔）：
1. 【条款矩阵】按条款/章节列出核心义务与权利。
2. 【风险清单】每条风险标注：风险描述、涉及条款、严重度（高/中/低）。
3. 【交叉引用冲突清单】不同卷之间对同一事项表述不一致的条目，标注"待人工核实"。
4. 【待办事项】客户在签署/执行前需要确认或补做的事项。
纯文本中文输出，不输出 JSON。`

const AGGREGATE_LEVEL2_USER_PROMPT = `文件类型：{docType}
规则字段汇总（全部）：
{fieldsJson}

各助手卷终稿摘要：
{reportsJson}

终稿：`

export interface ReadingContextInput {
  docType: string
  chunkIndex: number
  chunkTotal: number
  chunkText: string
  volumeSummary: string
  fields: GcDocumentFieldRow[]
}

export interface VolumeContextInput {
  factsJson: string
}

export interface Level1Input {
  docType: string
  fields: GcDocumentFieldRow[]
  volumes: Array<{ volume: number; summary: string }>
}

export interface Level2Input {
  docType: string
  fields: GcDocumentFieldRow[]
  reports: Array<{ agentName: string; report: string }>
}

export function buildReadingContext(input: ReadingContextInput): { systemPrompt: string; userPrompt: string } {
  const fieldsJson = input.fields.length > 0
    ? JSON.stringify(input.fields.map(f => ({ type: f.field_type, value: f.value, quote: f.quote })))
    : '（无）'
  return {
    systemPrompt: READING_SYSTEM_PROMPT,
    userPrompt: READING_USER_PROMPT
      .replace('{docType}', input.docType)
      .replace('{fieldsJson}', fieldsJson)
      .replace('{volumeSummary}', input.volumeSummary || '（第一块，无卷摘要）')
      .replace('{chunkIndex}', String(input.chunkIndex))
      .replace('{chunkTotal}', String(input.chunkTotal))
      .replace('{chunkText}', input.chunkText),
  }
}

export function buildVolumeSummaryContext(input: VolumeContextInput): { systemPrompt: string; userPrompt: string } {
  return {
    systemPrompt: VOLUME_SYSTEM_PROMPT,
    userPrompt: VOLUME_USER_PROMPT.replace('{factsJson}', input.factsJson),
  }
}

export function buildAggregateLevel1Context(input: Level1Input): { systemPrompt: string; userPrompt: string } {
  const fieldsJson = input.fields.length > 0
    ? JSON.stringify(input.fields.map(f => ({ type: f.field_type, value: f.value, quote: f.quote })))
    : '（无）'
  return {
    systemPrompt: AGGREGATE_LEVEL1_SYSTEM_PROMPT,
    userPrompt: AGGREGATE_LEVEL1_USER_PROMPT
      .replace('{docType}', input.docType)
      .replace('{fieldsJson}', fieldsJson)
      .replace('{volumesJson}', input.volumes.length > 0 ? JSON.stringify(input.volumes) : '（无）'),
  }
}

export function buildAggregateLevel2Context(input: Level2Input): { systemPrompt: string; userPrompt: string } {
  const fieldsJson = input.fields.length > 0
    ? JSON.stringify(input.fields.map(f => ({ type: f.field_type, value: f.value, quote: f.quote })))
    : '（无）'
  return {
    systemPrompt: AGGREGATE_LEVEL2_SYSTEM_PROMPT.replace('{N}', String(input.reports.length)),
    userPrompt: AGGREGATE_LEVEL2_USER_PROMPT
      .replace('{docType}', input.docType)
      .replace('{fieldsJson}', fieldsJson)
      .replace('{reportsJson}', input.reports.length > 0 ? JSON.stringify(input.reports) : '（无）'),
  }
}
