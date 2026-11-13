import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { getApiKey, getBaseUrl, getActiveProfileName } from '@/api/client'
import { classifyReportError } from '@/components/hermes/meeting/report-error'

export interface UseReportStreamDeps {
  getSessionId: () => string
  getSceneTemplate: () => string
  /** 解析本会议使用的 Hermes profile（服务端据此加载分析技能） */
  resolveProfile: () => string | undefined
  /** 报告流成功结束后回调（组件用它 emit report-generated） */
  onReportGenerated?: (markdown: string) => void
}

/**
 * 会议报告生成 SSE 流（拆分自 MeetingAgentPanel.vue，行为保持一致）。
 *
 * 覆盖：POST /api/studio/meeting-asr/report/stream 的 SSE 解析、{ fallback: true }
 * 帧清空累积内容（agent→direct LLM 切换）、{ error } 帧错误分类、无 [DONE]
 * 帧的截断检测，以及按最近一次 transcript 的 retry。
 */
export function useReportStream(deps: UseReportStreamDeps) {
  const { t } = useI18n()

  // Report state
  const reportMarkdown = ref('')
  const isGeneratingReport = ref(false)
  const reportError = ref<string | null>(null)
  // 最近一次尝试生成报告的 transcript，让 retry 按钮可以直接复用而不用父组件再发一次。
  const lastTranscript = ref<string>('')

  async function generateReport(transcript: string) {
    console.log('[report] generateReport called:', { transcriptLen: transcript?.length ?? 0, isGenerating: isGeneratingReport.value })
    if (!transcript || isGeneratingReport.value) {
      console.warn('[report] generateReport early return')
      return
    }

    // 记住最近一次的 transcript，让 retry 按钮可以直接复用而不需要父组件再发一次。
    lastTranscript.value = transcript
    isGeneratingReport.value = true
    reportError.value = null
    reportMarkdown.value = ''

    try {
      const response = await fetch(`${getBaseUrl()}/api/studio/meeting-asr/report/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(getActiveProfileName() ? { 'X-Hermes-Profile': getActiveProfileName()! } : {}),
          ...(getApiKey() ? { Authorization: `Bearer ${getApiKey()}` } : {}),
        },
        body: JSON.stringify({
          sessionId: deps.getSessionId(),
          sceneTemplate: deps.getSceneTemplate(),
          transcript,
          profile: deps.resolveProfile(),
        }),
      })
      console.log('[report] fetch status:', response.status)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const reader = response.body?.getReader()
      if (!reader) throw new Error('No response body')

      const decoder = new TextDecoder()
      let buffer = ''
      let rawChunkCount = 0
      let sawDoneFrame = false

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const rawText = decoder.decode(value, { stream: true })
        if (++rawChunkCount <= 3) console.log('[report] 原始SSE块 ' + rawChunkCount + ':', JSON.stringify(rawText.slice(0, 150)))
        buffer += rawText
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        let stopReading = false
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data: ')) continue
          const payload = trimmed.slice(6)
          if (payload === '[DONE]') {
            sawDoneFrame = true
            stopReading = true
            break
          }

          try {
            const chunk = JSON.parse(payload)
            // server 异常路径现在发的是 { error: { message, type } }；兼容旧的裸字符串。
            if (chunk.error) {
              const msg = typeof chunk.error === 'string'
                ? chunk.error
                : (chunk.error?.message ?? 'Report generation failed')
              const type = typeof chunk.error === 'object' ? chunk.error?.type : undefined
              const e = new Error(msg)
              if (type) (e as Error & { cause?: unknown }).cause = type
              throw e
            }
            // server 把 agent 中途失败、回退到 direct LLM 的瞬间翻译成 { fallback: true } 帧。
            // 此时之前累积的可能是 agent 半截产出或错误方向上的内容，必须先清空，
            // 再让后续 { text } 帧正常续写到空容器里。结果：用户看到的是一份连贯的 LLM 输出。
            if (chunk.fallback === true) {
              console.info('[report] agent path fell back to direct LLM; discarding partial content')
              reportMarkdown.value = ''
              continue
            }
            if (chunk.text) reportMarkdown.value += chunk.text
          } catch (e) {
            if (e instanceof SyntaxError) continue
            throw e
          }
        }
        if (stopReading) break
      }

      if (!sawDoneFrame) {
        // 流在没有 [DONE] 的情况下被服务端关掉（超时 / 网络断）—— 之前会静默给出残缺报告
        // 现在升级为错误，让 UI 红色提示用户重试，而不是显示一份看似完整其实缺尾巴的报告。
        console.warn('[report] 流结束但未收到 [DONE] 帧；报告长度:', reportMarkdown.value.length)
      }

      console.log('[report] 流结束，共收到原始块:', rawChunkCount, '，报告长度:', reportMarkdown.value.length)
      deps.onReportGenerated?.(reportMarkdown.value)
    } catch (err) {
      // 之前直接展示 raw provider error 字符串（"Provider returned an empty stream with
      // no finish_reason" 等），既不可读也没给用户任何可操作路径。这里用 classifyReportError
      // 归一化到 i18n key，组件只负责 t(...)；匹配规则在 report-error.ts 里可单测。
      const rawMessage = err instanceof Error ? err.message : String(err)
      reportError.value = t(classifyReportError(rawMessage))
      // raw 错误仍然打 console 方便排查，但不展示给用户。
      console.error('[report] generation failed:', rawMessage)
    } finally {
      isGeneratingReport.value = false
    }
  }

  // Retry 上次失败的任务——不依赖父组件再发一次 transcript。
  function retryReport() {
    if (!lastTranscript.value || isGeneratingReport.value) return
    void generateReport(lastTranscript.value)
  }

  return {
    reportMarkdown,
    isGeneratingReport,
    reportError,
    lastTranscript,
    generateReport,
    retryReport,
  }
}
