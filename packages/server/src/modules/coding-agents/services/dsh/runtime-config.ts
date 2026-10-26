import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseDocument, stringify } from 'yaml'
import { writeManagedPromptFile } from '../prompt-file'
import { updateDshMcpServer } from './config'
import { DSH_STREAM_PLUGIN } from './stream-plugin'
import { anchorDshPatch, prepareDshWebProfile } from './web-profile'
import type { CodingAgentContextPolicy } from '../context-policy'

export const DSH_MODEL_PROVIDER = 'ekko-studio'
export const DSH_API_KEY_ENV = 'HERMES_DSH_API_KEY'

// DSH's agent loop ends the turn on the first step that has no tool call, so a
// text-only "I will do X next" answer halts the run and waits for the user to
// say "继续". These rules are written into the AGENTS.md base (outside the
// managed upsert block) so they survive every per-turn prompt refresh.
//
// Phrased as a neutral agent-behavior guideline (not a harness-specific patch)
// so it stays correct for any model routed through DSH.
export const DSH_AGENT_CONTINUATION_INSTRUCTIONS = [
  '## 工具调用行为准则',
  '本会话中，一个"包含工具调用的步骤"会让任务继续执行，而"纯文字、不含工具调用的步骤"会结束本轮、等待你再次输入。',
  '1. 只要任务尚未真正完成，或你下一步需要执行任何动作（读写文件、运行命令、查询、调用 MCP 工具等），就在同一条回复里直接发出对应的工具调用，不要只用文字描述"我接下来要……"而把动作留到下一步。',
  '2. 只有当任务已全部完成、没有任何待执行的动作时，才用纯文字给出最终结论、总结或答案。',
  '3. 若某一步因为缺少信息而必须停下来向你提问，那么该次回复只包含问题本身，不要附带任何工具调用。',
].join('\n')

/**
 * Whether the DSH tool-call continuation guideline should be injected into the
 * AGENTS.md base.
 *
 * The agent loop ends the turn on the first step with no tool call, so a
 * text-only "I will do X next" answer halts the run until the user types
 * "继续". DeepSeek models reliably pair narration with the tool call in the same
 * step and never stall, so the guideline is redundant for them; non-DeepSeek
 * models (e.g. Qwen) intermittently emit standalone narration steps and need
 * it. Detect DeepSeek by the model id prefix — the only family DSH ships
 * natively.
 */
export function dshNeedsContinuationInstructions(model?: string): boolean {
  if (!model) return true
  return !/^deepseek/i.test(model)
}

export function dshReasoningEffort(value?: string): string | undefined {
  const level = value === 'max' ? 'xhigh' : value === 'none' ? 'off' : value
  return level && ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(level) ? level : undefined
}

export async function prepareDshRuntime(input: {
  sourceHome: string
  sharedSkills: string
  rootDir: string
  systemPrompt: string
  managedMcp: Record<string, Record<string, unknown>>
  model?: string
  baseUrl?: string
  contextWindow?: number
  outputLimit?: number
  contextPolicy?: CodingAgentContextPolicy
  imageInput?: boolean
  reasoningEffort?: string
  installationCommand?: string
  launchPath?: string
}) {
  await mkdir(input.rootDir, { recursive: true })
  const web = input.installationCommand ? await prepareDshWebProfile({ command: input.installationCommand, ...input }) : undefined
  const read = async (name: string) => {
    try { return await readFile(join(input.sourceHome, name), 'utf8') }
    catch (error: any) { if (error.code === 'ENOENT') return ''; throw error }
  }
  for (const name of ['settings.yaml', '.credentials.yaml', '.env']) {
    let content = await read(name)
    if (name === 'settings.yaml' && input.model && content) {
      const doc = parseDocument(content, { logLevel: 'silent' })
      if (doc.errors.length) throw new Error(`Invalid DSH settings: ${doc.errors[0].message}`)
      // The settings layer overrides composition config. Pin only Studio's route;
      // other native provider settings remain available to user-installed plugins.
      const providerPath = ['llm-pi-ai', 'providers', DSH_MODEL_PROVIDER]
      if (doc.hasIn(providerPath)) doc.deleteIn(providerPath)
      if (web) {
        // Scoped children and auxiliary model calls must use Studio's route.
        doc.delete('agent-default-model')
        doc.delete('subagent-model-selection')
      }
      if (input.contextPolicy) {
        // Settings are applied after composition config; stale native settings
        // must not replace the policy selected by Studio.
        doc.delete('compaction-basic')
      }
      content = String(doc)
    }
    await writeFile(join(input.rootDir, name), content || (name.endsWith('.yaml') ? '{}\n' : ''), { mode: 0o600 })
  }
  // Preserve profile-installed plugins, but keep sessions and writes in Studio's home.
  try {
    if (!web) await cp(join(input.sourceHome, 'profiles', 'acp'), join(input.rootDir, 'profiles', 'acp'), { recursive: true })
  } catch (error: any) { if (error.code !== 'ENOENT') throw error }
  let patch = await read('cordis.patch.yml')
  if (web) patch = anchorDshPatch(patch, join(input.sourceHome, 'cordis.patch.yml'))
  for (const [name, config] of Object.entries(input.managedMcp)) patch = updateDshMcpServer(patch, name, config)
  await writeFile(join(input.rootDir, 'cordis.patch.yml'), patch || '[]\n', { mode: 0o600 })
  const promptFile = join(input.rootDir, 'AGENTS.md')
  const pluginInstructions = web ? `\n\nDSH plugin configuration source: ${input.sourceHome}\nPlugin installation target: web profile. When invoking dsh plugin, explicitly set DSH_HOME to that source directory and pass --profile web. The inherited DSH_HOME is Studio's private conversation runtime; do not install packages into its profiles/web. Web backend plugins and the source default Agent preset are loaded when Studio next prepares an ACP runtime. Browser plugin interfaces are not hosted by Studio ACP.\n` : ''
  // Continuation rules live in the AGENTS.md base so the per-turn managed-block
  // upsert (chat-turn.ts) does not overwrite them. Only non-DeepSeek models need
  // them; DeepSeek self-pairs narration with tool calls and never stalls.
  const continuation = dshNeedsContinuationInstructions(input.model) ? `\n\n${DSH_AGENT_CONTINUATION_INSTRUCTIONS}` : ''
  await writeManagedPromptFile(promptFile, input.systemPrompt, (await read('AGENTS.md')) + pluginInstructions + continuation)
  const streamPluginPath = join(input.rootDir, 'studio-stream.mjs')
  await writeFile(streamPluginPath, DSH_STREAM_PLUGIN, { mode: 0o600 })
  const overlay: unknown[] = [
    { insert: [{ id: 'ekko-studio-assistant-stream', name: pathToFileURL(streamPluginPath).href }] },
    { id: 'session-persistence-jsonl', config: { root: join(input.rootDir, 'sessions'), compression: 'none' } },
    { id: 'skill-filesystem', config: { customSkillDirs: [join(input.sourceHome, 'skills'), input.sharedSkills] } },
    { id: 'sandbox-policy', config: { mode: 'danger-full-access' } },
    { id: 'approval', config: { policy: 'never' } },
    { id: 'permission', config: { defaultPreset: 'danger-full-access', presets: { 'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' } } } },
  ]
  if (web) overlay.push({ id: 'settings', config: { path: join(input.rootDir, 'settings.yaml'), watch: false } })
  if (input.contextPolicy) overlay.push({
    id: 'compaction-basic',
    disabled: false,
    config: {
      auto: true,
      thresholdRatio: input.contextPolicy.threshold,
      // Retention must stay below the trigger even for a small threshold.
      retainRatio: Math.min(0.16, input.contextPolicy.threshold / 2),
      modelPolicies: [],
    },
  })
  if (input.model) {
    overlay.push(
      { id: 'llm-deepseek', disabled: true },
      { id: 'llm-pi-ai', config: { providers: { [DSH_MODEL_PROVIDER]: {
        apiKeyEnv: DSH_API_KEY_ENV,
        api: 'openai-responses',
        baseURL: input.baseUrl,
        models: [{ id: input.model, contextWindow: input.contextWindow || 128_000, maxTokens: input.outputLimit || 8192,
          input: input.imageInput ? ['text', 'image'] : ['text'],
          ...(dshReasoningEffort(input.reasoningEffort) ? {
            reasoningEfforts: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
          } : {}),
        }],
      } } } },
      { id: web ? 'studio-web-acp' : 'acp', config: { provider: DSH_MODEL_PROVIDER, model: input.model } },
    )
    if (web) overlay.push(
      { id: 'agent-default-model', config: { provider: DSH_MODEL_PROVIDER, model: input.model } },
      { id: 'subagent-model-selection-settings', config: { enabled: false, allowedModels: [] } },
    )
  }
  const overlayPath = join(input.rootDir, 'studio.patch.yml')
  await writeFile(overlayPath, stringify(overlay), { mode: 0o600 })
  return {
    promptFile,
    args: ['--profile', web?.profile || 'acp', ...(web ? ['--patch', web.patch] : []), '--patch', overlayPath],
    env: { DSH_HOME: input.rootDir, DSH_PERMISSION_MODE: 'danger-full-access', ...(input.launchPath ? { PATH: input.launchPath } : {}) },
    files: ['settings.yaml', 'cordis.patch.yml', 'AGENTS.md', 'studio.patch.yml'].map(path => ({ key: path, path, absolutePath: join(input.rootDir, path) })),
  }
}
