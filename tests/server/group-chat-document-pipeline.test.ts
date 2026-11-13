/**
 * End-to-end document pipeline test: upload → chunk → reading (mocked bare
 * model) → rolling volume summaries → two-level aggregation → report message.
 *
 * Mirrors the mock strategy of group-chat-discussion.test.ts: the judge/reader
 * is a bare LLM call, so we mock `runBareModelAgent` and drive the pipeline
 * with scripted JSON outputs.
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// App home must be created before the config mock is evaluated (vi.mock
// factories are hoisted above imports) — use vi.hoisted + require so the
// callback has no dependency on top-level import bindings.
const TEST_HOME = vi.hoisted(() => {
  const { mkdtempSync, mkdirSync } = require('fs')
  const { tmpdir } = require('os')
  const { join } = require('path')
  const dir = mkdtempSync(join(tmpdir(), 'gc-pipeline-test-'))
  mkdirSync(join(dir, 'group-chat-docs'), { recursive: true })
  return dir
})

// Real in-memory SQLite backing getDb() so document-store CRUD works.
const dbMock = vi.hoisted(() => {
  const { DatabaseSync } = require('node:sqlite')
  return { db: new DatabaseSync(':memory:') }
})

vi.mock('../../packages/server/src/modules/studio/infrastructure/database', () => ({ getDb: () => dbMock.db }))

vi.mock('../../packages/server/src/modules/studio/services/group-chat/bare-model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/server/src/modules/studio/services/group-chat/bare-model')>()
  return {
    ...actual,
    runBareModelAgent: vi.fn(),
  }
})

vi.mock('../../packages/server/src/modules/studio/public/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/server/src/modules/studio/public/config')>()
  return {
    ...actual,
    config: { ...actual.config, appHome: TEST_HOME },
    getWebUiHome: () => TEST_HOME,
  }
})

import { runBareModelAgent } from '../../packages/server/src/modules/studio/services/group-chat/bare-model'
import { DocumentPipelineService } from '../../packages/server/src/modules/studio/services/group-chat/document-pipeline'
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import {
  getDocument,
  getFacts,
  getJobCounts,
  getVolumeSummaries,
  insertChunks,
  insertFields,
  saveDocument,
} from '../../packages/server/src/modules/studio/repositories/document-store'
import { parseDocumentFile } from '../../packages/server/src/modules/studio/services/group-chat/document-parser'

const modelMock = vi.mocked(runBareModelAgent)

const TEMP_DIRS: string[] = [TEST_HOME]

function writeUpload(roomId: string, fileId: string, content: string): string {
  const dir = join(TEST_HOME, 'group-chat-docs', roomId, fileId)
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'upload.bin')
  writeFileSync(filePath, content, 'utf-8')
  return filePath
}

function seedDocument(roomId: string, fileId: string, name: string, text: string, tokenBudget = 40000): number {
  writeUpload(roomId, fileId, text)
  const parsed = parseDocumentFile(join(TEST_HOME, 'group-chat-docs', roomId, fileId, 'upload.bin'), name, tokenBudget)
  insertChunks(fileId, parsed.chunks)
  insertFields(fileId, parsed.fields)
  saveDocument({
    file_id: fileId,
    room_id: roomId,
    name,
    size_bytes: Buffer.byteLength(text, 'utf-8'),
    doc_type: parsed.docType,
    encoding: parsed.encoding,
    chunk_count: parsed.chunks.length,
    chunk_token_budget: tokenBudget,
    status: 'chunked',
    report_message_id: '',
    created_at: Date.now(),
    updated_at: Date.now(),
  })
  return parsed.chunks.length
}

function readingFacts(chunkCount: number): string {
  const facts = Array.from({ length: Math.min(chunkCount, 3) }, (_, i) => ({
    type: '义务',
    content: `第${i + 1}块的核心义务`,
    quote: `原文片段${i + 1}`,
    cross_refs: [],
  }))
  return JSON.stringify(facts)
}

const AGENTS = [
  { agentId: 'agent-a', profile: 'p-a', provider: 'openai', model: 'gpt-test', apiMode: 'chat_completions', name: 'Agent A' },
  { agentId: 'agent-b', profile: 'p-b', provider: 'openai', model: 'gpt-test', apiMode: 'chat_completions', name: 'Agent B' },
]

beforeEach(() => {
  // Recreate tables (in-memory db is shared across tests) and clear any rows.
  initAllHermesTables()
  for (const table of ['gc_documents', 'gc_file_chunks', 'gc_document_fields', 'gc_document_facts', 'gc_reading_jobs', 'gc_volume_summaries']) {
    dbMock.db.exec(`DELETE FROM ${table}`)
  }
  modelMock.mockReset()
  modelMock.mockImplementation(async (input: any) => {
    if (input.purpose === 'group-chat-document-reading') return readingFacts(3)
    if (input.purpose === 'group-chat-document-volume') return '卷摘要：已覆盖本卷义务与风险。'
    if (input.purpose === 'group-chat-document-level1') return '卷终稿：本卷义务已汇总。'
    if (input.purpose === 'group-chat-document-report') {
      return ['【条款矩阵】第一条：甲方义务。', '【风险清单】1. 高风险：逾期支付。', '【交叉引用冲突清单】无。', '【待办事项】1. 确认付款节点。'].join('\n')
    }
    throw new Error(`unexpected purpose ${input.purpose}`)
  })
})

afterEach(() => {
  modelMock.mockReset()
  for (const dir of TEMP_DIRS.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

describe('document pipeline', () => {
  it('runs upload→read→aggregate and emits a report message via hooks', async () => {
    const roomId = 'room-1'
    const fileId = 'gcd_test_1'
    // 3 chunks so volume summary (VOLUME_SIZE=10) never triggers — pure reading path.
    seedDocument(roomId, fileId, '合同.txt', '房屋租赁合同\n' + '第1条 甲方应于2025年1月1日支付人民币10,000元。\n'.repeat(60), 40000)

    const events: string[] = []
    const service = new DocumentPipelineService({
      onDocumentReady: (_roomId, _payload) => events.push('ready'),
      onProgress: (_roomId, _payload) => events.push('progress'),
      onReport: (_roomId, fileIdOut, reportText) => {
        events.push(`report:${fileIdOut}`)
        expect(reportText).toContain('【条款矩阵】')
      },
    })

    const result = await service.startReading(fileId, AGENTS)
    expect(result.jobsAssigned).toBeGreaterThan(0)

    // Wait for the async pump to finish.
    await vi.waitFor(() => {
      const doc = getDocument(fileId)
      expect(doc?.status).toBe('done')
    }, { timeout: 15_000, interval: 200 })

    const jobs = getJobCounts(fileId)
    expect(jobs.failed).toBe(0)
    expect(jobs.done).toBe(jobs.total)
    expect(getFacts(fileId).length).toBeGreaterThan(0)

    const readingCalls = modelMock.mock.calls.filter(c => c[0].purpose === 'group-chat-document-reading')
    expect(readingCalls.length).toBe(jobs.total)
    // Each reading call passes the chunk text + fields in the user prompt.
    expect(readingCalls[0][0].userPrompt).toContain('第1条')

    const reportCalls = modelMock.mock.calls.filter(c => c[0].purpose === 'group-chat-document-report')
    expect(reportCalls.length).toBe(1)
    expect(events).toContain('ready')
    expect(events.some(e => e.startsWith('report:'))).toBe(true)
  })

  it('rolls volume summaries every VOLUME_SIZE done chunks per agent', async () => {
    const roomId = 'room-2'
    const fileId = 'gcd_test_2'
    // Long enough to produce >10 chunks for the single agent (each ~2K chars).
    const text = '通用协议文本\n' + '第1条 双方确认支付人民币20,000元。\n'.repeat(8000)
    seedDocument(roomId, fileId, '协议.txt', text, 2000)

    const service = new DocumentPipelineService({
      onDocumentReady: () => {},
      onProgress: () => {},
      onReport: () => {},
    })

    await service.startReading(fileId, [AGENTS[0]])
    await vi.waitFor(() => {
      const doc = getDocument(fileId)
      expect(doc?.status).toBe('done')
    }, { timeout: 30_000, interval: 200 })

    const volumes = getVolumeSummaries(fileId, AGENTS[0].agentId)
    expect(volumes.length).toBeGreaterThan(0)
    const volumeCalls = modelMock.mock.calls.filter(c => c[0].purpose === 'group-chat-document-volume')
    expect(volumeCalls.length).toBe(volumes.length)
  }, 60_000)

  it('marks document failed when a report model call throws', async () => {
    const roomId = 'room-3'
    const fileId = 'gcd_test_3'
    seedDocument(roomId, fileId, 'a.txt', '测试文本\n' + '第1条 甲方义务。\n'.repeat(30), 40000)

    modelMock.mockImplementation(async (input: any) => {
      if (input.purpose === 'group-chat-document-report') throw new Error('report boom')
      return readingFacts(1)
    })

    const service = new DocumentPipelineService({
      onDocumentReady: () => {},
      onProgress: () => {},
      onReport: () => {},
    })

    await service.startReading(fileId, [AGENTS[0]])
    await vi.waitFor(() => {
      const doc = getDocument(fileId)
      expect(doc?.status).toBe('failed')
    }, { timeout: 20_000, interval: 200 })
  }, 30_000)
})
