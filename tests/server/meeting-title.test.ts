import { describe, expect, it, vi } from 'vitest'
import { cleanMeetingTitle, generateMeetingTitle } from '../../packages/server/src/modules/studio/services/meeting-asr/direct-llm'

function fakeDeps(content: string | null, ok = true) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    json: async () => (ok
      ? { choices: [{ message: { content } }] }
      : {}),
    text: async () => 'nope',
  })
  return {
    fetchImpl: fetchMock,
    loadConfig: async () => ({ apiKey: 'sk-test', baseUrl: 'https://mock.local/v1', model: 'test-model' }),
    fetchMock,
  }
}

describe('cleanMeetingTitle', () => {
  it('strips wrappers and keeps first line', () => {
    expect(cleanMeetingTitle('「Q3 供应商评审」')).toBe('Q3 供应商评审')
    expect(cleanMeetingTitle('# 季度复盘会')).toBe('季度复盘会')
    expect(cleanMeetingTitle('标题：周会总结')).toBe('周会总结')
    expect(cleanMeetingTitle('项目会对齐。')).toBe('项目会对齐')
  })
  it('returns null for empty', () => {
    expect(cleanMeetingTitle('')).toBeNull()
    expect(cleanMeetingTitle('   ')).toBeNull()
  })
})

describe('generateMeetingTitle', () => {
  it('posts a chat completion and returns the cleaned title', async () => {
    const { fetchMock, ...deps } = fakeDeps('季度产品规划会')
    const title = await generateMeetingTitle('转写内容…', deps as any)
    expect(title).toBe('季度产品规划会')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // 校验发送了命名提示词
    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(init.body)
    expect(body.messages[0].role).toBe('system')
    expect(JSON.stringify(body.messages[0].content)).toContain('会议命名助手')
  })

  it('returns null gracefully when the LLM call fails', async () => {
    const deps = fakeDeps(null, false)
    const title = await generateMeetingTitle('转写内容…', deps as any)
    expect(title).toBeNull()
  })

  it('returns null when there is no LLM config', async () => {
    const deps = {
      loadConfig: async () => null,
    }
    const title = await generateMeetingTitle('转写内容…', deps as any)
    expect(title).toBeNull()
  })

  it('returns null on empty transcript', async () => {
    const { fetchMock, ...deps } = fakeDeps('whatever')
    expect(await generateMeetingTitle('   ', deps as any)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
