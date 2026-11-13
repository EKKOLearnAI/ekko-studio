import fs from 'fs/promises'
import path from 'path'
import { existsSync, mkdirSync } from 'fs'
import { logger } from '../public/logging'
import { getUploadDir } from '../public/config'

/**
 * 口语对练分析报告落盘服务。
 *
 * 客户端在口语对练会话结束后把生成的 Markdown 分析报告 POST 到这里，
 * 本服务把文本写成 `.md` 文件并返回绝对路径与文件名；下载复用
 * `/api/studio/download`（该路由对 upload 目录内的文件始终用 localProvider
 * 读取，docker/ssh 等远程 profile backend 部署下也能取到宿主盘文件）。
 *
 * 目录解析遵守 AGENTS.md 硬规则：必须经 `config.getUploadDir()`
 * （`UPLOAD_DIR` > `HERMES_WEB_UI_HOME/upload` > `~/.hermes-web-ui/upload`），
 * 不得直接读 `process.env` 或 `process.cwd()`。
 */

/** 单份报告最大字符数（约 512 KB 的 UTF-8 文本），防止超大 body 落盘。 */
export const PRACTICE_REPORT_MAX_CHARS = 512 * 1024

/**
 * 把建议文件名净化成安全的文件 stem：去掉路径分隔符 / 保留字 / 控制字符，
 * 防止通过 suggestedName 逃逸 baseDir（`../../evil.md` 这类）。
 */
function sanitizeStem(input: string): string {
  const cleaned = (input || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, 80)
    .trim()
  return cleaned || 'speech-practice-report'
}

function timestampStamp(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

export class SpeechPracticeReportStore {
  private static instance: SpeechPracticeReportStore | null = null
  private baseDir: string

  private constructor() {
    this.baseDir = path.join(getUploadDir(), 'speech-practice')
    this.ensureBaseDir()
    logger.info('[speech-practice-report] baseDir resolved to %s', this.baseDir)
  }

  static getInstance(): SpeechPracticeReportStore {
    if (!SpeechPracticeReportStore.instance) {
      SpeechPracticeReportStore.instance = new SpeechPracticeReportStore()
    }
    return SpeechPracticeReportStore.instance
  }

  private ensureBaseDir(): void {
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true })
      logger.info('[speech-practice-report] created directory %s', this.baseDir)
    }
  }

  /** 供测试与诊断使用（不要用于拼接用户可控路径）。 */
  getBaseDir(): string {
    return this.baseDir
  }

  /**
   * 把 Markdown 报告写入 baseDir 下的 `.md` 文件。
   * 文件名 = 净化后的 stem + 时间戳，撞名时追加序号，保证不覆盖历史报告。
   *
   * @throws Error 带 code：`empty_report` / `report_too_large` / `write_failed`
   */
  async saveReport(
    markdown: string,
    suggestedStem?: string,
  ): Promise<{ fileName: string; absPath: string }> {
    if (typeof markdown !== 'string' || !markdown.trim()) {
      throw Object.assign(new Error('Markdown report is empty'), { code: 'empty_report' })
    }
    if (markdown.length > PRACTICE_REPORT_MAX_CHARS) {
      throw Object.assign(new Error(`Report too large (max ${PRACTICE_REPORT_MAX_CHARS} chars)`), {
        code: 'report_too_large',
      })
    }

    const stem = sanitizeStem(suggestedStem ?? '')
    const stamp = timestampStamp(Date.now())
    let fileName = `${stem}-${stamp}.md`
    let index = 1
    while (existsSync(path.join(this.baseDir, fileName))) {
      fileName = `${stem}-${stamp}-${index}.md`
      index += 1
    }
    const absPath = path.join(this.baseDir, fileName)

    try {
      await fs.writeFile(absPath, markdown, 'utf8')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('[speech-practice-report] write failed: %s', message)
      throw Object.assign(new Error(`Failed to write report: ${message}`), { code: 'write_failed' })
    }
    logger.info('[speech-practice-report] saved report %s (%d chars)', fileName, markdown.length)
    return { fileName, absPath }
  }
}

export const speechPracticeReportStore = SpeechPracticeReportStore.getInstance()
