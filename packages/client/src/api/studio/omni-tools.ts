import { fetchMemory, fetchSkillContent, fetchSkillFiles, fetchSkills } from '../hermes/skills'
import { listJobs } from '../hermes/jobs'
import { fetchSessions } from './sessions'
import { getApiKey } from '@/api/client'

/**
 * Qwen Omni Realtime 模型（`qwen3.8-omni-flash-realtime`、
 * `qwen3.8-omni-plus-realtime`、
 * 以及 `qwen3-omni-flash-realtime` 都走同一份 OpenAI-Realtime 兼容协议）
 * 的 function calling 工具集。
 *
 * 形状遵循 OpenAI-Realtime 的扁平格式（type/name/description/parameters），
 * 由 `useOmniRealtime` 通过 `start` 帧下发给 Python 代理写入 session.update，
 * 模型触发后回传 `function_call` 事件，客户端执行并把结果以 `tool_result`
 * 控制帧回传，模型继续作答。
 */

export interface OmniRealtimeToolDefinition {
  type: 'function'
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

/** 工具结果送回上游前的最大字符数，避免撑爆会话上下文。 */
const TOOL_OUTPUT_LIMIT = 4_000

export const OMNI_REALTIME_TOOLS: OmniRealtimeToolDefinition[] = [
  {
    type: 'function',
    name: 'query_agent_memory',
    description:
      '查询用户 Agent 的长期记忆，包括 memory（长期记忆）、user（用户画像）、soul（人格）三个分区。'
      + '当用户问到「还记得吗 / 我是谁 / 我的偏好 / 我们之前聊过什么」等问题时调用，不要凭空编造记忆。',
    parameters: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: '可选。只返回包含该关键词的记忆条目；不传则返回记忆摘要。',
        },
        section: {
          type: 'string',
          enum: ['memory', 'user', 'soul', 'all'],
          description: '可选。要查询的记忆分区，默认 all。',
        },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'list_agent_skills',
    description:
      '列出用户 Agent 已配置的技能（名称、简介、分类、是否启用）。'
      + '当用户问「你能做什么 / 有哪些技能 / 会不会某某能力」时调用。',
    parameters: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: '可选。按名称或简介过滤技能。',
        },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'read_skill_detail',
    description:
      '读取某个技能的 SKILL.md 详细说明。需要先通过 list_agent_skills 拿到 category 与 skill 名称。',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', description: '技能分类名。' },
        skill: { type: 'string', description: '技能名。' },
      },
      required: ['category', 'skill'],
    },
  },
  {
    type: 'function',
    name: 'list_recent_sessions',
    description:
      '查看用户最近的对话会话列表（标题、消息数、最近活跃时间）。'
      + '当用户问「最近聊了什么 / 之前那个会话」时调用。',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: '可选。返回条数，默认 8，最大 20。',
        },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'list_jobs',
    description:
      '查看当前配置的定时任务 / 自动化任务（名称、计划、是否启用、下次运行时间）。'
      + '当用户问「我有哪些定时任务 / 自动化在跑什么」时调用。',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    type: 'function',
    name: 'query_hermes_agent',
    description:
      '把用户随口问的一个具体问题交给后端 Hermes Agent 跑一次。Agent 会使用当前 profile '
      + '的 MCP 工具、技能、终端、文件系统等真实能力，并把最终回复文本返回。'
      + '当用户问的问题需要真实工具操作或工作区读取时调用（例如「读一下 ~/projects/xxx 下的 README」、'
      + '「运行某个脚本查一下端口占用」、「查 MCP 数据库里 X 表的内容」）。'
      + '不要把语音对话中整段最近的转写塞进来——一次只问一件具体的事。'
      + 'question 是必填参数：禁止传空参数，也不要只靠上下文猜；如果用户说得不够具体，'
      + '先用口语向用户确认要查的内容，再带着完整 question 调用。'
      + '回答时不要逐字复述工具返回的文本，用口语简短总结关键结论。',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: '要交给 Hermes Agent 执行的自然语言问题，简洁具体。',
        },
      },
      required: ['question'],
    },
  },
]

/**
 * 口语对练专用评分工具。
 *
 * 口语对练模式下，模型在每一轮用户发言结束后调用本工具提交结构化打分
 * （随 `function_call` 事件回传）。执行器在客户端完成：
 *   - 实时刷新右侧评分卡（本轮各维度分数 / 亮点 / 可提升点）；
 *   - 把每条评分累积进练习数据，供结束后的 Markdown 分析报告使用；
 *   - 向模型回传简短确认文本（如「已记录第 N 轮评分」），让对话继续。
 *
 * 分数统一 1–10 整数。不要用散装文字代替结构化打分——本工具正是为了让
 * 打分「可见、可累积、可入报告」，而不是混在朗读文本里。
 */
export const SUBMIT_PRACTICE_FEEDBACK_TOOL: OmniRealtimeToolDefinition = {
  type: 'function',
  name: 'submit_practice_feedback',
  description:
    '口语对练专用：每轮用户发言结束后，把对本轮表现的结构化打分与点评通过本工具提交'
    + '（客户端会实时显示在评分卡上，并进入最终的分析报告）。'
    + '评分后再用目标语言口头简短总结一句，然后继续引导下一轮练习。',
  parameters: {
    type: 'object',
    properties: {
      overall: { type: 'number', description: '本轮总分，1-10 整数。', minimum: 1, maximum: 10 },
      fluency: { type: 'number', description: '流利度评分，1-10 整数。', minimum: 1, maximum: 10 },
      pronunciation: { type: 'number', description: '发音/语调评分，1-10 整数。', minimum: 1, maximum: 10 },
      grammar: { type: 'number', description: '语法准确度评分，1-10 整数。', minimum: 1, maximum: 10 },
      vocabulary: { type: 'number', description: '词汇与表达丰富度评分，1-10 整数。', minimum: 1, maximum: 10 },
      content: { type: 'number', description: '内容与逻辑评分，1-10 整数。', minimum: 1, maximum: 10 },
      bodyLanguage: {
        type: 'number',
        description: '肢体语言/仪态/眼神交流评分，1-10 整数。只在摄像头开启、你能看到用户画面时填写；看不到画面一律不填。',
        minimum: 1,
        maximum: 10,
      },
      comment: {
        type: 'string',
        description: '对本轮表现的一句话点评（用练习目标语言书写）。',
      },
      strengths: {
        type: 'string',
        description: '亮点，一两句（用练习目标语言书写）。',
      },
      improvements: {
        type: 'string',
        description: '本轮最重要的 1 个可提升点（用练习目标语言书写）。',
      },
      example: {
        type: 'string',
        description: '更自然/更地道的表达示范或纠错示范，一两句（用练习目标语言书写）。',
      },
    },
    required: [
      'overall', 'fluency', 'pronunciation', 'grammar', 'vocabulary', 'content', 'comment',
    ],
  },
}

/**
 * 口语对练模式完整工具集：既有工作台工具（记忆 / 技能 / 会话 / 任务 /
 * `query_hermes_agent` 的 Agent 能力全部保留）＋ 对练评分工具。
 */
export const PRACTICE_REALTIME_TOOLS: OmniRealtimeToolDefinition[] = [
  ...OMNI_REALTIME_TOOLS,
  SUBMIT_PRACTICE_FEEDBACK_TOOL,
]

function clip(value: string, limit = TOOL_OUTPUT_LIMIT): string {
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}…(truncated)`
}

function normalize(value: unknown): string {
  if (value == null) return ''
  return String(value).replace(/\s+/g, ' ').trim()
}

async function toolQueryMemory(rawArgs: Record<string, unknown>): Promise<string> {
  const keyword = normalize(rawArgs.keyword).toLowerCase()
  const section = normalize(rawArgs.section) || 'all'
  const data = await fetchMemory()
  const sections: Array<[string, string]> = [
    ['memory', data.memory],
    ['user', data.user],
    ['soul', data.soul],
  ]
  const parts: string[] = []
  for (const [name, content] of sections) {
    if (section !== 'all' && section !== name) continue
    let text = (content || '').trim()
    if (!text) continue
    if (keyword) {
      const lines = text.split('\n').filter(line => line.toLowerCase().includes(keyword))
      text = lines.join('\n')
    }
    if (!text) continue
    parts.push(`## ${name}\n${clip(text, 1_500)}`)
  }
  return clip(parts.length > 0 ? parts.join('\n\n') : '（记忆为空，未找到相关内容）')
}

async function toolListSkills(rawArgs: Record<string, unknown>): Promise<string> {
  const keyword = normalize(rawArgs.keyword).toLowerCase()
  const data = await fetchSkills()
  const rows: string[] = []
  for (const category of data.categories || []) {
    for (const skill of category.skills || []) {
      const haystack = `${skill.name} ${skill.description} ${category.name}`.toLowerCase()
      if (keyword && !haystack.includes(keyword)) continue
      rows.push(`- ${category.name}/${skill.name}${skill.enabled === false ? '（未启用）' : '（启用）'}：${normalize(skill.description)}`)
    }
  }
  return clip(rows.length > 0 ? rows.slice(0, 80).join('\n') : '（没有匹配的技能）')
}

async function toolReadSkillDetail(rawArgs: Record<string, unknown>): Promise<string> {
  const category = normalize(rawArgs.category)
  const skill = normalize(rawArgs.skill)
  if (!category || !skill) return JSON.stringify({ error: 'category 和 skill 必填' })
  const files = await fetchSkillFiles(category, skill)
  const entryFile = (files || []).find(file => file.path.endsWith('SKILL.md'))
  if (!entryFile) {
    return clip(JSON.stringify({ files: (files || []).map(file => file.path) }))
  }
  const content = await fetchSkillContent(entryFile.path)
  return clip((content || '').trim() || '（该技能没有内容）')
}

async function toolListRecentSessions(rawArgs: Record<string, unknown>): Promise<string> {
  const rawLimit = Number(rawArgs.limit)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(20, Math.floor(rawLimit)) : 8
  const sessions = await fetchSessions(undefined, limit)
  const rows = (sessions || []).map(session => ({
    title: session.title || '(未命名)',
    agent: session.agent || 'hermes',
    messages: session.message_count,
    lastActiveAt: session.last_active ?? session.started_at,
  }))
  return clip(JSON.stringify(rows, null, 1))
}

async function toolListJobs(): Promise<string> {
  const jobs = await listJobs()
  const rows = (jobs || []).map(job => ({
    name: job.name,
    enabled: job.enabled,
    state: job.state,
    schedule: job.schedule_display,
    nextRunAt: job.next_run_at,
    lastStatus: job.last_status,
  }))
  return clip(JSON.stringify(rows, null, 1))
}

/**
 * 通过服务端 `/api/studio/realtime/agent-query` 把问题丢给 Hermes Agent
 * 跑一次（Agent 可使用当前 profile 的 MCP / skills / terminal / 文件系统）。
 * 服务端已经做了 agent 优雅失败识别与 16 KB 输出截断，这里只负责包装结果。
 */
async function toolQueryHermesAgent(rawArgs: Record<string, unknown>): Promise<string> {
  const question = normalize(rawArgs.question)
  if (!question) return JSON.stringify({ error: 'question 必填' })
  if (question.length > 2_000) return JSON.stringify({ error: 'question 太长（最多 2000 字）' })

  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 75_000)
  try {
    const response = await fetch('/api/studio/realtime/agent-query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(getApiKey() ? { Authorization: `Bearer ${getApiKey()}` } : {}),
      },
      body: JSON.stringify({ question }),
      signal: controller.signal,
    })
    const payload = await response.json().catch(() => ({} as Record<string, unknown>))
    if (!response.ok || payload?.ok === false) {
      const message = String(payload?.error || `agent-query failed (${response.status})`)
      return JSON.stringify({ error: message })
    }
    const text = String(payload?.text || '').trim()
    if (!text) return JSON.stringify({ error: 'agent 返回为空' })
    return clip(text, 3_500)
  } catch (cause) {
    if ((cause as Error)?.name === 'AbortError') {
      return JSON.stringify({ error: 'agent 调用超时（>75s）' })
    }
    const message = cause instanceof Error ? cause.message : String(cause)
    return JSON.stringify({ error: message })
  } finally {
    window.clearTimeout(timeout)
  }
}

/**
 * 执行一个工具调用并把结果序列化为字符串（失败时返回 {"error": ...}，
 * 让模型能够向用户如实说明）。
 */
export async function executeOmniTool(name: string, argsJson: string): Promise<string> {
  let args: Record<string, unknown> = {}
  try {
    const parsed: unknown = argsJson ? JSON.parse(argsJson) : {}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>
    }
  } catch {
    return JSON.stringify({ error: '无效的工具参数 JSON' })
  }

  try {
    switch (name) {
      case 'query_agent_memory': return await toolQueryMemory(args)
      case 'list_agent_skills': return await toolListSkills(args)
      case 'read_skill_detail': return await toolReadSkillDetail(args)
      case 'list_recent_sessions': return await toolListRecentSessions(args)
      case 'list_jobs': return await toolListJobs()
      case 'query_hermes_agent': return await toolQueryHermesAgent(args)
      default: return JSON.stringify({ error: `未知工具：${name}` })
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return JSON.stringify({ error: message })
  }
}
