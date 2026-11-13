import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getProfileDir } from './profile'
import { logger } from '../../../studio/public/logging'

/**
 * Quanta 默认人格种子写入。
 *
 * 背景：SOUL.md 的出厂模板（"You are Hermes Agent, an intelligent AI
 * assistant created by Nous Research…"）来自外部 hermes CLI 运行时，本仓库
 * 无法改它的生成逻辑。这里在 Web UI 侧补齐：profile 创建后，若 SOUL.md
 * 缺失或仍是出厂默认模板，则覆写为 Quanta 人格。
 *
 * 守卫：只覆写「缺失」或「与已知出厂模板匹配」的 SOUL.md——用户自定义过
 * 的人格绝不触碰（一旦用户改过，开头就不再是出厂文案）。
 */

export const QUANTA_SOUL_TEMPLATE = [
  'You are Quanta, the user\'s personal AI assistant in the Hermes workspace.',
  '',
  '你是 Quanta，用户在 Hermes 工作台中的个人智能助手。你贯穿用户的日常工作：',
  '回答问题、读写文件、执行终端命令、调用 MCP 工具与技能、处理会议与语音对话。',
  '',
  '行为准则：',
  '- 用中文回答（除非用户明确使用其他语言），语气自然、直接、不啰嗦。',
  '- 涉及工作台数据时调用工具获取事实，不凭空编造。',
  '- 通过语音对话时，用口语化短句回答（两三句为宜），不输出 Markdown 标记。',
  '- 承认不确定性，优先真正解决问题而不是长篇大论。',
  '',
  '用户可以在下方追加自定义设定来进一步塑造你的人格。',
].join('\n')

/**
 * 出厂默认模板的特征前缀（hermes CLI 运行时生成）。命中才允许覆写——
 * 这是「未被用户修改过」的判定依据。
 */
const LEGACY_SOUL_PREFIXES = [
  'You are Hermes Agent',
  'You are Hermes,',
]

function isLegacyDefaultSoul(content: string): boolean {
  const trimmed = content.trimStart()
  return LEGACY_SOUL_PREFIXES.some(prefix => trimmed.startsWith(prefix))
}

/**
 * 为指定 profile 种子化 Quanta 人格。
 *
 * 返回 'seeded'（新写入）/ 'upgraded'（覆写出厂模板）/ 'kept'（已有自定义
 * soul，不动）。任何文件系统错误都只记日志不抛出——人格种子写入失败不应
 * 阻断 profile 创建流程。
 */
export async function seedQuantaSoul(profileName: string): Promise<'seeded' | 'upgraded' | 'kept'> {
  try {
    const dir = getProfileDir(profileName)
    const soulPath = join(dir, 'SOUL.md')
    if (existsSync(soulPath)) {
      const current = await readFile(soulPath, 'utf8').catch(() => '')
      if (!isLegacyDefaultSoul(current)) return 'kept'
      await writeFile(soulPath, QUANTA_SOUL_TEMPLATE, 'utf8')
      logger.info('seed-quanta-soul: upgraded legacy default SOUL.md for profile "%s"', profileName)
      return 'upgraded'
    }
    await mkdir(dir, { recursive: true })
    await writeFile(soulPath, QUANTA_SOUL_TEMPLATE, 'utf8')
    logger.info('seed-quanta-soul: seeded Quanta SOUL.md for profile "%s"', profileName)
    return 'seeded'
  } catch (err) {
    logger.error(err, 'seed-quanta-soul failed for profile "%s" (non-fatal)', profileName)
    return 'kept'
  }
}
