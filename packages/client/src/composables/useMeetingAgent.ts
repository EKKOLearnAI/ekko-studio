import { ref, computed } from 'vue'
import { useMeetingStore, type TranscriptSentence, type AgentMessage, type AnalysisResult, type AgentConfig } from '@/stores/hermes/meeting'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useAppStore } from '@/stores/hermes/app'
import { startRunViaSocket, registerSessionHandlers, type RunEvent, type StartRunRequest } from '@/api/studio/chat'
import { inferCodingAgentApiMode, normalizeCodingAgentApiMode, type ChatCodingAgentId } from '@/api/coding-agents'
import { meetingStorageApi } from '@/utils/meeting-storage-api'
import { tryParseJson, looksLikeHtmlDocument, escHtml, extractCorrections } from '@/composables/useMeetingAnalysis'

// 默认提示词模板
const DEFAULT_PROMPT_TEMPLATE = `你是一个专业的会议分析助手。你的任务是分析会议逐字稿，生成详细的会议分析报告。

## 工作流程

### 第一步：判断会议类型
根据逐字稿内容，判断这是什么类型的会议：
- **会议纪要**：包含议题、讨论、决议、待办事项和负责人
- **客户回访**：包含客户反馈、满意度、问题、建议
- **头脑风暴**：包含创意、想法、可行性分析
- **项目汇报**：包含进度、风险、下一步计划
- **培训分享**：包含知识点、要点、学习建议
- **其他**：根据实际内容判断

### 第二步：根据会议类型决定是否使用工具
**需要使用工具的情况**：
- 客户回访：搜索客户历史记录、产品文档、常见问题解决方案
- 项目汇报：查看项目文档、历史会议记录、风险评估模板
- 培训分享：搜索相关知识库、文档、参考资料

**不需要使用工具的情况**：
- 简单的会议纪要：直接提取关键信息
- 头脑风暴：直接分析创意和想法

### 第三步：生成分析结果并输出JSON
根据会议类型，生成JSON格式的分析结果。

### 第四步：生成HTML报告
**这是最关键的一步。** 你必须完成以下两件事：

1. **使用 write_file 工具** 将HTML报告保存为 \`meeting-report.html\`
2. **在回复末尾** 以 \`\`\`html 代码块形式输出完整的HTML内容

HTML报告要求：
- 必须是完整的HTML文档（<!DOCTYPE html>开头，</html>结尾）
- 包含所有CSS样式，可以直接在浏览器打开
- 设计要专业、美观、有创意，体现会议内容特点
- 包含会议摘要、关键要点、待办事项、决议等所有分析结果
- 可以使用图表（ECharts CDN: https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js）
- 针对不同会议类型设计不同的视觉风格

## 输出格式
你的回复应该包含两部分：

**第一部分：JSON分析结果**
\`\`\`json
{
  "meeting_type": "会议类型",
  "summary": "会议摘要",
  "key_points": ["关键要点"],
  "action_items": [{"task": "待办", "assignee": "负责人", "deadline": "截止时间"}],
  "feedback": {"positive": ["积极反馈"], "negative": ["消极反馈"]},
  "decisions": ["决议"],
  "risks": ["风险"],
  "learnings": ["知识点"],
  "people_mentioned": ["人名"],
  "relationships": [{"source": "人A", "target": "人B", "relation": "关系"}],
  "topics": ["主题"]
}
\`\`\`

**第二部分：HTML报告**
\`\`\`html
<!DOCTYPE html>
<html lang="zh-CN">
...
</html>
\`\`\`

注意：
1. 根据会议类型，JSON中某些字段可以为空数组
2. HTML必须是完整的、可直接打开的网页
3. 两部分缺一不可

会议逐字稿：
{transcript}`

// 提示词模板存储 key
const PROMPT_TEMPLATE_KEY = 'hermes.meeting.promptTemplate'

export function useMeetingAgent(sessionId: string) {
  const meetingStore = useMeetingStore()
  const profilesStore = useProfilesStore()
  const appStore = useAppStore()

  const messages = ref<AgentMessage[]>([])
  const isRunning = ref(false)
  const error = ref<string | null>(null)
  const analysisResult = ref<AnalysisResult | null>(null)
  const reportHtml = ref<string>('')
  const completed = ref(false)
  const correctedSentences = ref<TranscriptSentence[] | null>(null)

  // 提示词模板
  const promptTemplate = ref(loadPromptTemplate())

  // 当前会议 session
  const session = computed(() => {
    return meetingStore.sessions.find(s => s.id === sessionId)
  })

  // Agent 配置
  const agentConfig = computed<AgentConfig>(() => {
    return session.value?.agentConfig || { agentType: 'hermes', profile: 'default' }
  })

  // 加载提示词模板
  function loadPromptTemplate(): string {
    try {
      const saved = localStorage.getItem(PROMPT_TEMPLATE_KEY)
      return saved || DEFAULT_PROMPT_TEMPLATE
    } catch {
      return DEFAULT_PROMPT_TEMPLATE
    }
  }

  // 保存提示词模板
  function savePromptTemplate(template: string) {
    try {
      localStorage.setItem(PROMPT_TEMPLATE_KEY, template)
      promptTemplate.value = template
    } catch {}
  }

  // 重置提示词模板为默认
  function resetPromptTemplate() {
    promptTemplate.value = DEFAULT_PROMPT_TEMPLATE
    localStorage.removeItem(PROMPT_TEMPLATE_KEY)
  }

  // 生成唯一 ID
  function uid(): string {
    return `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }

  // 保存消息到 store
  function saveMessages() {
    if (sessionId) {
      meetingStore.updateSession(sessionId, { agentMessages: [...messages.value] })
    }
  }

  // 添加消息（只添加 assistant 和 tool 消息）
  function addMessage(msg: AgentMessage) {
    messages.value.push(msg)
    saveMessages()
  }

  // 格式化逐字稿
  function formatTranscript(sentences: TranscriptSentence[]): string {
    return sentences.map(s => {
      const speaker = s.speaker ? `[${s.speaker}] ` : ''
      return `${speaker}${s.text}`
    }).join('\n')
  }

  // 构建分析 prompt
  function buildAnalysisPrompt(sentences: TranscriptSentence[]): string {
    const transcript = formatTranscript(sentences)
    const speakers = session.value?.speakers || []
    
    let speakerInfo = ''
    if (speakers.length > 0) {
      speakerInfo = `\n说话人信息：\n${speakers.map(s => `- ${s.id}: ${s.displayName}`).join('\n')}\n`
    }

    return `请分析以下会议逐字稿，生成详细的会议纪要。
${speakerInfo}
逐字稿内容：
${transcript}

请开始分析。`
  }

  // 从 assistant 消息中提取 JSON 结果
  function extractJsonResult(): AnalysisResult | null {
    const assistantMsgs = messages.value.filter(m => m.role === 'assistant')
    if (assistantMsgs.length === 0) return null

    // 从后向前扫描，优先取最后一条 assistant 消息；
    // 如果解析失败，再往前回退尝试。
    for (let i = assistantMsgs.length - 1; i >= 0; i--) {
      const content = assistantMsgs[i].content || ''
      const parsed = tryParseJson(content)
      if (parsed) return parsed
    }

    return null
  }

  // 从 assistant 消息中提取 HTML 内容（兜底方案）
  function extractHtmlFromMessages(): string {
    const assistantMsgs = messages.value.filter(m => m.role === 'assistant')
    for (let i = assistantMsgs.length - 1; i >= 0; i--) {
      const content = assistantMsgs[i].content || ''
      // 尝试提取 ```html ... ``` 代码块
      const htmlBlock = content.match(/```html\s*([\s\S]*?)```/i)
      if (htmlBlock && looksLikeHtmlDocument(htmlBlock[1].trim())) {
        return htmlBlock[1].trim()
      }
      // 尝试提取 <html>...</html> 片段
      const htmlMatch = content.match(/(<!DOCTYPE html>[\s\S]*<\/html>|<html[\s\S]*<\/html>)/i)
      if (htmlMatch && htmlMatch[1].length > 200) {
        return htmlMatch[1]
      }
    }
    
    // 如果从单条消息中没找到，尝试从所有消息中拼接 HTML
    const allContent = assistantMsgs.map(m => m.content || '').join('\n')
    const htmlBlock = allContent.match(/```html\s*([\s\S]*?)```/i)
    if (htmlBlock && looksLikeHtmlDocument(htmlBlock[1].trim())) {
      return htmlBlock[1].trim()
    }
    const htmlMatch = allContent.match(/(<!DOCTYPE html>[\s\S]*<\/html>|<html[\s\S]*<\/html>)/i)
    if (htmlMatch && htmlMatch[1].length > 200) {
      return htmlMatch[1]
    }
    
    return ''
  }

  // 生成 HTML 报告（从结构化数据生成模板报告）
  function generateHtmlReport(analysis: AnalysisResult): string {
    const meetingTitle = session.value?.title || '会议'
    const meetingType = (analysis as any).meeting_type || '会议分析'
    const genTime = new Date().toLocaleString('zh-CN')

    const esc = escHtml

    const topicsHtml = (analysis.topics || [])
      .map(t => `<span class="topic-tag">${esc(t)}</span>`)
      .join('')

    const keyPointsHtml = (analysis.key_points || [])
      .map((p, i) => `
        <div class="key-point-card">
          <div class="key-point-number">${i + 1}</div>
          <div class="key-point-text">${esc(p)}</div>
        </div>`)
      .join('')

    const actionItemsHtml = (analysis.action_items || [])
      .map(item => {
        if (item == null) return ''
        if (typeof item === 'string') {
          return `
            <div class="action-item">
              <input type="checkbox" class="action-checkbox">
              <span class="action-text">${esc(item)}</span>
            </div>`
        }
        const task = (item as any).task || (item as any).text || ''
        const assignee = (item as any).assignee ? `<span class="action-assignee">👤 ${esc((item as any).assignee)}</span>` : ''
        const deadline = (item as any).deadline ? `<span class="action-deadline">📅 ${esc((item as any).deadline)}</span>` : ''
        const meta = (assignee || deadline) ? `<div class="action-meta">${assignee}${deadline}</div>` : ''
        return `
          <div class="action-item">
            <input type="checkbox" class="action-checkbox">
            <div class="action-body">
              <span class="action-text">${esc(task)}</span>
              ${meta}
            </div>
          </div>`
      })
      .join('')

    const decisionsHtml = (analysis.decisions || [])
      .map((d, i) => `
        <div class="decision-item">
          <div class="decision-number">${i + 1}</div>
          <div class="decision-text">${esc(d)}</div>
        </div>`)
      .join('')

    const risksHtml = (analysis.risks || [])
      .map(r => `<li>${esc(r)}</li>`)
      .join('')

    const learningsHtml = (analysis.learnings || [])
      .map(l => `<li>${esc(l)}</li>`)
      .join('')

    const positiveFeedbackHtml = ((analysis.feedback?.positive) || [])
      .map(f => `<li>${esc(f)}</li>`)
      .join('')
    const negativeFeedbackHtml = ((analysis.feedback?.negative) || [])
      .map(f => `<li>${esc(f)}</li>`)
      .join('')

    const peopleHtml = (analysis.people_mentioned || [])
      .map(p => `<span class="person-chip">${esc(p)}</span>`)
      .join('')

    const relationshipsHtml = (analysis.relationships || [])
      .map(r => `
        <div class="relationship-item">
          <span class="rel-source">${esc((r as any).source)}</span>
          <span class="rel-arrow">→</span>
          <span class="rel-target">${esc((r as any).target)}</span>
          <span class="rel-desc">${esc((r as any).relation)}</span>
        </div>`)
      .join('')

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(meetingTitle)} - 会议分析报告</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
      color: #333;
    }
    .container { max-width: 880px; margin: 0 auto; }
    .header {
      background: rgba(255, 255, 255, 0.97);
      border-radius: 16px;
      padding: 32px;
      margin-bottom: 20px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.12);
    }
    .header h1 { font-size: 26px; color: #1a1a2e; margin-bottom: 8px; }
    .header .meta { color: #888; font-size: 13px; margin-bottom: 4px; }
    .header .type-badge {
      display: inline-block;
      padding: 4px 12px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border-radius: 12px;
      font-size: 12px;
      margin-top: 8px;
    }
    .summary-box {
      background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
      border-radius: 12px;
      padding: 20px;
      margin-top: 18px;
      font-size: 15px;
      line-height: 1.7;
      color: #2d3748;
    }
    .topics-container { margin-top: 16px; display: flex; flex-wrap: wrap; gap: 8px; }
    .topic-tag {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 5px 14px;
      border-radius: 20px;
      font-size: 13px;
    }
    .card {
      background: rgba(255, 255, 255, 0.97);
      border-radius: 16px;
      padding: 26px;
      margin-bottom: 20px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.12);
    }
    .card h2 {
      font-size: 19px;
      color: #1a1a2e;
      margin-bottom: 18px;
      padding-bottom: 10px;
      border-bottom: 2px solid #f0f0f5;
    }
    .empty-hint { color: #999; font-size: 14px; font-style: italic; }
    .key-point-card {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 14px;
      background: #f8f9fa;
      border-radius: 10px;
      margin-bottom: 10px;
    }
    .key-point-number {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      width: 28px; height: 28px;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 13px; font-weight: bold;
      flex-shrink: 0;
    }
    .key-point-text { font-size: 14px; line-height: 1.6; color: #333; }
    .action-item {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 12px 14px;
      background: #fff8e1;
      border-radius: 10px;
      margin-bottom: 10px;
      border-left: 4px solid #ffc107;
    }
    .action-checkbox { width: 18px; height: 18px; margin-top: 3px; cursor: pointer; flex-shrink: 0; }
    .action-body { flex: 1; }
    .action-text { font-size: 14px; line-height: 1.5; color: #333; display: block; }
    .action-meta { margin-top: 6px; display: flex; gap: 12px; font-size: 12px; color: #856404; }
    .decision-item {
      display: flex; align-items: flex-start; gap: 12px;
      padding: 12px 14px;
      background: #e8f5e9;
      border-radius: 10px;
      margin-bottom: 10px;
      border-left: 4px solid #4caf50;
    }
    .decision-number {
      background: #4caf50;
      color: white;
      width: 24px; height: 24px;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 12px; font-weight: bold;
      flex-shrink: 0;
    }
    .decision-text { font-size: 14px; line-height: 1.5; color: #2e7d32; }
    .feedback-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
    }
    .feedback-block {
      padding: 14px;
      border-radius: 10px;
    }
    .feedback-positive { background: #e8f5e9; border-left: 4px solid #4caf50; }
    .feedback-negative { background: #ffebee; border-left: 4px solid #ef5350; }
    .feedback-block h3 { font-size: 14px; margin-bottom: 8px; }
    .feedback-positive h3 { color: #2e7d32; }
    .feedback-negative h3 { color: #c62828; }
    .feedback-block ul { margin-left: 20px; font-size: 13px; line-height: 1.6; }
    .feedback-positive ul li { color: #2e7d32; }
    .feedback-negative ul li { color: #c62828; }
    .people-container { display: flex; flex-wrap: wrap; gap: 8px; }
    .person-chip {
      padding: 5px 12px;
      background: #e3f2fd;
      color: #1565c0;
      border-radius: 14px;
      font-size: 13px;
    }
    .relationship-item {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 14px;
      background: #f3e5f5;
      border-radius: 10px;
      margin-bottom: 8px;
      flex-wrap: wrap;
    }
    .rel-source, .rel-target { font-weight: 600; color: #6a1b9a; font-size: 14px; }
    .rel-arrow { color: #9c27b0; font-size: 16px; }
    .rel-desc { color: #555; font-size: 13px; flex: 1; min-width: 100px; }
    .simple-list { margin-left: 20px; font-size: 14px; line-height: 1.7; }
    .footer {
      text-align: center;
      color: rgba(255, 255, 255, 0.85);
      font-size: 13px;
      padding: 20px;
    }
    @media (max-width: 600px) {
      .feedback-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${esc(meetingTitle)}</h1>
      <div class="meta">生成时间：${esc(genTime)}</div>
      <div class="type-badge">${esc(meetingType)}</div>
      ${analysis.summary ? `<div class="summary-box"><strong>摘要：</strong>${esc(analysis.summary)}</div>` : ''}
      ${topicsHtml ? `<div class="topics-container">${topicsHtml}</div>` : ''}
    </div>

    ${keyPointsHtml ? `
    <div class="card">
      <h2>关键要点</h2>
      ${keyPointsHtml}
    </div>` : ''}

    ${actionItemsHtml ? `
    <div class="card">
      <h2>待办事项</h2>
      ${actionItemsHtml}
    </div>` : ''}

    ${decisionsHtml ? `
    <div class="card">
      <h2>决议</h2>
      ${decisionsHtml}
    </div>` : ''}

    ${(positiveFeedbackHtml || negativeFeedbackHtml) ? `
    <div class="card">
      <h2>反馈</h2>
      <div class="feedback-grid">
        ${positiveFeedbackHtml ? `<div class="feedback-block feedback-positive"><h3>积极反馈</h3><ul>${positiveFeedbackHtml}</ul></div>` : ''}
        ${negativeFeedbackHtml ? `<div class="feedback-block feedback-negative"><h3>消极反馈</h3><ul>${negativeFeedbackHtml}</ul></div>` : ''}
      </div>
    </div>` : ''}

    ${risksHtml ? `
    <div class="card">
      <h2>风险</h2>
      <ul class="simple-list">${risksHtml}</ul>
    </div>` : ''}

    ${learningsHtml ? `
    <div class="card">
      <h2>知识点</h2>
      <ul class="simple-list">${learningsHtml}</ul>
    </div>` : ''}

    ${peopleHtml ? `
    <div class="card">
      <h2>提及人物</h2>
      <div class="people-container">${peopleHtml}</div>
    </div>` : ''}

    ${relationshipsHtml ? `
    <div class="card">
      <h2>人物关系</h2>
      ${relationshipsHtml}
    </div>` : ''}

    ${!keyPointsHtml && !actionItemsHtml && !analysis.summary && !decisionsHtml && !risksHtml && !learningsHtml && !positiveFeedbackHtml && !negativeFeedbackHtml && !peopleHtml && !relationshipsHtml ? `
    <div class="card">
      <h2>分析结果</h2>
      <p class="empty-hint">暂无结构化数据，请检查 Agent 输出。</p>
    </div>` : ''}

    <div class="footer">会议分析报告 · 由 Hermes Agent 生成</div>
  </div>
</body>
</html>`
  }

  // 发送消息到 agent（不显示用户消息泡泡）
  async function sendMessage(content: string, instructions?: string) {
    if (!content.trim() || !session.value) return
    if (isRunning.value) return

    // 不添加用户消息到显示列表
    isRunning.value = true
    error.value = null

    try {
      await sendToAgent(content.trim(), instructions)
    } catch (err: any) {
      error.value = err.message || '发送失败'
      isRunning.value = false
    }
    // 注意: isRunning.value = false 由 onRunCompleted/onRunFailed 回调设置
  }

  // 发送到 agent (核心逻辑)
  async function sendToAgent(content: string, instructions?: string) {
    if (!session.value) return

    const config = agentConfig.value
    const agentSessionId = session.value.agentSessionId || `meeting-agent-${sessionId}`

    if (!session.value.agentSessionId) {
      meetingStore.updateSession(sessionId, { agentSessionId: agentSessionId })
    }

    const payload: StartRunRequest = {
      input: content,
      session_id: agentSessionId,
      profile: config.profile || profilesStore.activeProfileName || 'default',
      model: config.model,
      provider: config.provider,
      source: config.agentType === 'hermes' ? 'cli' : 'coding_agent',
      instructions: instructions || promptTemplate.value,
    }

    if (config.agentType === 'claude-code' || config.agentType === 'codex') {
      const codingAgentId: ChatCodingAgentId = config.agentType === 'claude-code' ? 'claude-code' : 'codex'
      const codingAgentMode = config.codingAgentMode || 'scoped'
      
      payload.coding_agent_id = codingAgentId
      payload.mode = codingAgentMode

      if (codingAgentMode === 'scoped') {
        const providerGroup = appStore.modelGroups.find(g => g.provider === config.provider)
        if (providerGroup) {
          payload.baseUrl = providerGroup.base_url
          payload.apiKey = providerGroup.api_key
          payload.apiMode = normalizeCodingAgentApiMode(
            providerGroup.api_mode,
            inferCodingAgentApiMode(providerGroup.provider, providerGroup.base_url)
          )
        }
      }
    }

    let activeAssistantMessageId: string | null = null

    const cleanup = registerSessionHandlers(agentSessionId, {
      onMessageDelta: (evt: RunEvent) => {
        const text = evt.delta || ''
        if (!text) return

        if (activeAssistantMessageId) {
          const msg = messages.value.find(m => m.id === activeAssistantMessageId)
          if (msg) {
            msg.content += text
          }
        } else {
          const newId = uid()
          activeAssistantMessageId = newId
          addMessage({
            id: newId,
            role: 'assistant',
            content: text,
            timestamp: Date.now(),
            status: 'sent'
          })
        }
      },
      onMessageInterim: (evt: RunEvent) => {
        const text = evt.text || evt.delta || ''
        if (!text) return
        if (activeAssistantMessageId) {
          const msg = messages.value.find(m => m.id === activeAssistantMessageId)
          if (msg) {
            msg.content = text
          }
        } else {
          addMessage({
            id: uid(),
            role: 'assistant',
            content: text,
            timestamp: Date.now(),
            status: 'sent'
          })
        }
        activeAssistantMessageId = null
      },
      onReasoningDelta: (evt: RunEvent) => {
        const text = evt.text || evt.delta || ''
        if (!text) return

        if (activeAssistantMessageId) {
          const msg = messages.value.find(m => m.id === activeAssistantMessageId)
          if (msg) {
            msg.reasoning = (msg.reasoning || '') + text
          }
        }
      },
      onThinkingDelta: (evt: RunEvent) => {
        const text = evt.text || evt.delta || ''
        if (!text) return

        if (activeAssistantMessageId) {
          const msg = messages.value.find(m => m.id === activeAssistantMessageId)
          if (msg) {
            msg.reasoning = (msg.reasoning || '') + text
          }
        }
      },
      onReasoningAvailable: () => {},
      onToolStarted: (evt: RunEvent) => {
        const toolId = uid()
        addMessage({
          id: toolId,
          role: 'tool',
          content: '',
          timestamp: Date.now(),
          toolName: evt.tool || evt.name,
          toolCallId: (evt as any).tool_call_id,
          toolStatus: 'running',
          toolArgs: (evt as any).arguments,
          toolPreview: evt.preview,
          _expanded: false,
        })
        activeAssistantMessageId = null
      },
      onToolCompleted: (evt: RunEvent) => {
        const toolCallId = (evt as any).tool_call_id as string | undefined
        const toolMsg = toolCallId
          ? [...messages.value].reverse().find(m => m.role === 'tool' && m.toolCallId === toolCallId)
          : [...messages.value].reverse().find(m => m.role === 'tool' && m.toolStatus === 'running' && m.toolName === (evt.tool || evt.name))
        if (toolMsg) {
          toolMsg.toolStatus = evt.error ? 'error' : 'done'
          toolMsg.toolResult = (evt as any).output ?? (evt as any).result
          toolMsg.toolDuration = (evt as any).duration
          saveMessages()
        }
      },
      onRunStarted: () => {
        isRunning.value = true
        activeAssistantMessageId = null
      },
      onRunCompleted: (_evt: RunEvent) => {
        isRunning.value = false
        activeAssistantMessageId = null
        cleanup()
        
        // 提取 JSON 结果
        const result = extractJsonResult()
        if (result) {
          analysisResult.value = result
          meetingStore.updateAnalysis(sessionId, result)
        }

        // 获取 AI 生成的 HTML 报告（按优先级）
        let html = ''

        // 1. 从工具调用中提取 HTML 内容
        const toolMsgs = messages.value.filter(m => m.role === 'tool' && m.toolStatus === 'done')
        for (const msg of toolMsgs) {
          if (!msg.toolArgs) continue
          try {
            const args = typeof msg.toolArgs === 'string' ? JSON.parse(msg.toolArgs) : msg.toolArgs
            const filePath = args?.path || args?.file_path || args?.filename || ''
            const content = args?.content || args?.data || args?.text || ''
            
            // 检查是否是 HTML 文件
            if (filePath.endsWith('.html') && content) {
              html = content
              break
            }
            
            // 检查内容是否像 HTML 文档
            if (content && looksLikeHtmlDocument(content)) {
              html = content
              break
            }
          } catch { /* ignore parse error */ }
        }

        // 2. 从工具结果中提取 HTML
        if (!html) {
          for (const msg of toolMsgs) {
            if (!msg.toolResult) continue
            const result = typeof msg.toolResult === 'string' ? msg.toolResult : JSON.stringify(msg.toolResult)
            if (looksLikeHtmlDocument(result)) {
              html = result
              break
            }
          }
        }

        // 3. 从 assistant 消息中提取 ```html ... ``` 代码块
        if (!html) {
          html = extractHtmlFromMessages()
        }

        // 4. 如果有结果但没有 AI 生成的 HTML，用模板兜底
        if (!html && result) {
          html = generateHtmlReport(result)
        }

        if (html) {
          reportHtml.value = html
          meetingStore.updateHtmlContent(sessionId, html)
          
          // 保存到服务器
          meetingStorageApi.saveHtmlReport(sessionId, html)
            .then(() => console.log('HTML report saved to server'))
            .catch(err => console.error('Failed to save HTML report to server:', err))
        }

        // 保存 JSON 到服务器
        if (result) {
          meetingStorageApi.saveJsonReport(sessionId, result)
            .then(() => console.log('JSON report saved to server'))
            .catch(err => console.error('Failed to save JSON report to server:', err))
        }

        // 标记完成
        completed.value = true
        saveMessages()
      },
      onRunFailed: (evt: RunEvent) => {
        const errorMsg = evt.error || '运行失败'
        error.value = errorMsg
        isRunning.value = false
        activeAssistantMessageId = null
        cleanup()
        
        addMessage({
          id: uid(),
          role: 'system',
          content: `错误: ${errorMsg}`,
          timestamp: Date.now(),
          status: 'error'
        })
        saveMessages()
      },
      onCompressionStarted: () => {},
      onCompressionCompleted: () => {},
      onAbortStarted: () => {},
      onAbortCompleted: () => {
        isRunning.value = false
        cleanup()
      },
      onUsageUpdated: () => {},
    })

    const ctrl = startRunViaSocket(
      payload,
      () => {},
      () => {
        isRunning.value = false
        cleanup()
      },
      (err: Error) => {
        error.value = err.message
        isRunning.value = false
        cleanup()
      }
    )

    return ctrl
  }

  // 开始分析逐字稿
  async function startAnalysis(sentences: TranscriptSentence[]) {
    if (!sentences.length) {
      error.value = '没有可分析的逐字稿'
      return
    }

    // 防止重复触发
    if (isRunning.value) return

    // 清空之前的结果
    messages.value = []
    analysisResult.value = null
    reportHtml.value = ''
    error.value = null
    completed.value = false
    saveMessages()

    const prompt = buildAnalysisPrompt(sentences)
    await sendMessage(prompt)
  }

  // 中止运行
  function abortRun() {
    isRunning.value = false
  }

  // 清空所有（重置为全新对话）
  function clearAll() {
    messages.value = []
    analysisResult.value = null
    reportHtml.value = ''
    error.value = null
    completed.value = false
    // 重置 agent session ID，开启全新对话
    if (session.value) {
      meetingStore.updateSession(sessionId, {
        agentMessages: [],
        agentSessionId: undefined,
        analysisResult: null,
        htmlContent: '',
      })
    }
  }

  // 生成报告（调用 Agent 生成 HTML 报告和总结）
  async function generateReport(sentences: TranscriptSentence[]) {
    if (!sentences.length || isRunning.value) return

    isRunning.value = true
    error.value = null

    const transcript = formatTranscript(sentences)
    const meetingTitle = session.value?.title || '会议'
    
    // 获取之前的分析结果（如果有）
    const existingAnalysis = analysisResult.value
    const existingAnalysisJson = existingAnalysis ? JSON.stringify(existingAnalysis, null, 2) : ''
    
    // 获取之前的对话内容（如果有）
    const previousMessages = messages.value
      .filter(m => m.role === 'assistant' || m.role === 'system')
      .map(m => `[${m.role}]: ${m.content}`)
      .join('\n\n')

    // 专门用于生成报告的 instructions
    const reportInstructions = `你是一个专业的会议分析助手。你的任务是根据会议逐字稿和之前的分析内容，生成一份完整的 HTML 报告。

## 必须完成的任务

### 1. 参考之前的分析内容
如果提供了之前的分析结果，请参考这些内容来生成报告，而不是重新分析。

### 2. 生成 HTML 报告
**这是最重要的任务。** 你必须：

1. **使用 write_file 工具** 将完整的 HTML 报告保存为 \`meeting-report.html\`
2. **在回复中** 以 \`\`\`html 代码块形式输出完整的 HTML 内容

### 3. HTML 报告要求
- 必须是完整的 HTML 文档（<!DOCTYPE html> 开头，</html> 结尾）
- 包含所有内联 CSS 样式
- 设计专业、美观
- 包含会议摘要、关键要点、待办事项、决议等所有分析结果
- 可以使用 ECharts 图表（CDN: https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js）

### 4. 输出格式
你的回复必须包含两部分：

**第一部分：JSON 分析结果**
\`\`\`json
{
  "meeting_type": "会议类型",
  "summary": "会议摘要",
  "key_points": ["关键要点"],
  "action_items": [{"task": "待办", "assignee": "负责人", "deadline": "截止时间"}],
  "decisions": ["决议"],
  "risks": ["风险"],
  "learnings": ["知识点"],
  "people_mentioned": ["人物"],
  "relationships": [{"source": "人物A", "target": "人物B", "relation": "关系"}],
  "topics": ["主题"]
}
\`\`\`

**第二部分：HTML 报告**
\`\`\`html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>${meetingTitle} - 会议分析报告</title>
  <style>
    /* 在这里添加 CSS 样式 */
  </style>
</head>
<body>
  <!-- 在这里添加 HTML 内容 -->
</body>
</html>
\`\`\`

**重要提示：**
1. 你必须使用 write_file 工具保存 HTML 报告
2. 你必须在回复中输出完整的 HTML 代码块
3. JSON 和 HTML 两部分缺一不可
4. 如果有之前的分析结果，请基于它生成报告，不要重复分析`

    // 构建报告生成的 prompt，包含逐字稿和之前的分析内容
    let reportPrompt = `请根据以下会议内容生成 HTML 报告。

## 会议标题
${meetingTitle}

## 会议逐字稿
${transcript}`

    // 如果有之前的分析结果，添加到 prompt 中
    if (existingAnalysisJson) {
      reportPrompt += `\n\n## 之前的分析结果
请参考以下分析结果来生成报告：
\`\`\`json
${existingAnalysisJson}
\`\`\``
    }

    // 如果有之前的对话内容，添加到 prompt 中
    if (previousMessages) {
      reportPrompt += `\n\n## 之前的对话内容
${previousMessages}`
    }

    reportPrompt += `\n\n请开始生成报告。`

    await sendMessage(reportPrompt, reportInstructions)
  }

  // 纠正 ASR 字幕中的错别字
  async function correctTranscript(sentences: TranscriptSentence[]): Promise<TranscriptSentence[] | null> {
    if (!sentences.length || isRunning.value) return null

    isRunning.value = true
    error.value = null

    const transcriptLines = sentences.map((s, i) => {
      const speaker = s.speaker ? `[${s.speaker}] ` : ''
      return `${i}: ${speaker}${s.text}`
    })
    const transcript = transcriptLines.join('\n')

    const correctionPrompt = `你是一个专业的ASR纠错助手。请检查以下转写文本中的错别字、同音字、语法错误，并返回修正结果。

## 任务说明
- 仔细检查每一行文本的错别字、同音字、语法错误
- 只返回有错误的条目，无错误的条目不要包含
- 必须严格按照指定的JSON格式返回

## 转写文本
${transcript}

## 返回格式
请严格按照以下JSON格式返回，不要添加任何其他内容：

\`\`\`json
{"corrections": [{"index": 0, "original": "原文", "corrected": "纠正后", "reason": "原因"}]}
\`\`\`

如果没有错误，返回：
\`\`\`json
{"corrections": []}
\`\`\`

## 重要提示
1. index 是行号（从0开始）
2. original 是原文中的错误部分（必须是原文的子串）
3. corrected 是修正后的文本
4. reason 是修正原因（可选）
5. 只返回JSON，不要返回其他任何文字说明`

    const config = agentConfig.value
    const correctionSessionId = `correct-${sessionId}-${Date.now()}`

    const payload: StartRunRequest = {
      input: correctionPrompt,
      session_id: correctionSessionId,
      profile: config.profile || profilesStore.activeProfileName || 'default',
      model: config.model,
      provider: config.provider,
      source: 'cli',
      // 添加明确的指令，防止agent调用其他工具
      instructions: '你是一个ASR纠错助手。只分析文本中的错别字并返回JSON格式的修正结果。不要调用任何工具，只返回JSON。',
    }

    let activeAssistantMessageId: string | null = null
    let responseContent = ''

    const cleanup = registerSessionHandlers(correctionSessionId, {
      onMessageDelta: (evt: RunEvent) => {
        const text = evt.delta || ''
        if (!text) return
        responseContent += text

        if (activeAssistantMessageId) {
          const msg = messages.value.find(m => m.id === activeAssistantMessageId)
          if (msg) {
            msg.content += text
          }
        } else {
          const newId = uid()
          activeAssistantMessageId = newId
          addMessage({
            id: newId,
            role: 'assistant',
            content: text,
            timestamp: Date.now(),
            status: 'sent'
          })
        }
      },
      onMessageInterim: (evt: RunEvent) => {
        const text = evt.text || evt.delta || ''
        if (!text) return
        responseContent += text
        if (activeAssistantMessageId) {
          const msg = messages.value.find(m => m.id === activeAssistantMessageId)
          if (msg) {
            msg.content = text
          }
        } else {
          addMessage({
            id: uid(),
            role: 'assistant',
            content: text,
            timestamp: Date.now(),
            status: 'sent'
          })
        }
        activeAssistantMessageId = null
      },
      onReasoningDelta: (evt: RunEvent) => {
        const text = evt.text || evt.delta || ''
        if (!text) return
        if (activeAssistantMessageId) {
          const msg = messages.value.find(m => m.id === activeAssistantMessageId)
          if (msg) {
            msg.reasoning = (msg.reasoning || '') + text
          }
        }
      },
      onThinkingDelta: (evt: RunEvent) => {
        const text = evt.text || evt.delta || ''
        if (!text) return
        if (activeAssistantMessageId) {
          const msg = messages.value.find(m => m.id === activeAssistantMessageId)
          if (msg) {
            msg.reasoning = (msg.reasoning || '') + text
          }
        }
      },
      onReasoningAvailable: () => {},
      onToolStarted: (evt: RunEvent) => {
        // 如果agent尝试调用工具，记录但不阻止
        const toolId = uid()
        addMessage({
          id: toolId,
          role: 'tool',
          content: '',
          timestamp: Date.now(),
          toolName: evt.tool || evt.name,
          toolCallId: (evt as any).tool_call_id,
          toolStatus: 'running',
          toolArgs: (evt as any).arguments,
          toolPreview: evt.preview,
          _expanded: false,
        })
        activeAssistantMessageId = null
      },
      onToolCompleted: (evt: RunEvent) => {
        const toolCallId = (evt as any).tool_call_id as string | undefined
        const toolMsg = toolCallId
          ? [...messages.value].reverse().find(m => m.role === 'tool' && m.toolCallId === toolCallId)
          : [...messages.value].reverse().find(m => m.role === 'tool' && m.toolStatus === 'running' && m.toolName === (evt.tool || evt.name))
        if (toolMsg) {
          toolMsg.toolStatus = evt.error ? 'error' : 'done'
          toolMsg.toolResult = (evt as any).output ?? (evt as any).result
          toolMsg.toolDuration = (evt as any).duration
        }
      },
      onRunStarted: () => {
        activeAssistantMessageId = null
      },
      onRunCompleted: () => {
        cleanup()

        // 从响应中提取 corrections
        const corrections = extractCorrections(responseContent)

        if (corrections && corrections.length > 0) {
          const corrected = [...sentences]
          let appliedCount = 0
          
          for (const c of corrections) {
            if (c.index >= 0 && c.index < corrected.length && c.corrected) {
              const originalText = corrected[c.index].text
              // 如果 original 存在且是原文的子串，做子字符串替换
              if (c.original && originalText.includes(c.original)) {
                corrected[c.index] = { ...corrected[c.index], text: originalText.replace(c.original, c.corrected) }
              } else {
                // 否则替换整个句子
                corrected[c.index] = { ...corrected[c.index], text: c.corrected }
              }
              appliedCount++
            }
          }

          const details = corrections
            .filter(c => c.index >= 0 && c.index < sentences.length)
            .map(c => {
              const originalText = sentences[c.index].text
              const before = c.original || originalText
              const after = (c.original && originalText.includes(c.original)) 
                ? originalText.replace(c.original, c.corrected) 
                : c.corrected
              return `第${c.index + 1}句: "${before}" → "${after}"${c.reason ? ` (${c.reason})` : ''}`
            })
            .join('\n')

          addMessage({
            id: uid(),
            role: 'system',
            content: `纠错完成，共修正 ${appliedCount} 处：\n${details}`,
            timestamp: Date.now(),
            status: 'sent'
          })

          correctedSentences.value = corrected
          meetingStore.updateSession(sessionId, { sentences: corrected })
          isRunning.value = false
          saveMessages()
        } else {
          // 如果没有提取到corrections，可能是agent返回了其他格式
          // 尝试解析整个响应内容
          const fallbackCorrections = extractCorrections(responseContent)
          
          if (fallbackCorrections && fallbackCorrections.length > 0) {
            // 使用备用解析结果
            const corrected = [...sentences]
            let appliedCount = 0
            
            for (const c of fallbackCorrections) {
              if (c.index >= 0 && c.index < corrected.length && c.corrected) {
                const originalText = corrected[c.index].text
                if (c.original && originalText.includes(c.original)) {
                  corrected[c.index] = { ...corrected[c.index], text: originalText.replace(c.original, c.corrected) }
                } else {
                  corrected[c.index] = { ...corrected[c.index], text: c.corrected }
                }
                appliedCount++
              }
            }

            addMessage({
              id: uid(),
              role: 'system',
              content: `纠错完成，共修正 ${appliedCount} 处`,
              timestamp: Date.now(),
              status: 'sent'
            })

            correctedSentences.value = corrected
            meetingStore.updateSession(sessionId, { sentences: corrected })
          } else {
            addMessage({
              id: uid(),
              role: 'system',
              content: '未发现需要纠正的错别字',
              timestamp: Date.now(),
              status: 'sent'
            })
          }
          isRunning.value = false
          saveMessages()
        }
      },
      onRunFailed: (evt: RunEvent) => {
        const errorMsg = evt.error || '纠错失败'
        error.value = errorMsg
        cleanup()
        isRunning.value = false
        saveMessages()
      },
      onCompressionStarted: () => {},
      onCompressionCompleted: () => {},
      onAbortStarted: () => {},
      onAbortCompleted: () => {
        cleanup()
        isRunning.value = false
      },
      onUsageUpdated: () => {},
    })

    startRunViaSocket(payload, () => {}, () => {}, () => {
      cleanup()
      isRunning.value = false
    })

    return null
  }

  // 初始化
  function init() {
    if (session.value?.analysisResult) {
      analysisResult.value = session.value.analysisResult
    }
    if (session.value?.htmlContent) {
      reportHtml.value = session.value.htmlContent
    }
    if (session.value?.agentMessages?.length) {
      messages.value = [...session.value.agentMessages]
    }
  }

  init()

  return {
    messages,
    isRunning,
    error,
    analysisResult,
    reportHtml,
    completed,
    correctedSentences,
    agentConfig,
    promptTemplate,
    sendMessage,
    startAnalysis,
    generateReport,
    abortRun,
    clearAll,
    correctTranscript,
    savePromptTemplate,
    resetPromptTemplate,
  }
}