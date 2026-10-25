import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { StudioError, type AgentRuntimeContext, type ModelGatewayHandle, type JsonObject } from '@ekko-studio/plugin-sdk'

export async function scopedCodeBuddy(runtime: AgentRuntimeContext, gateway: ModelGatewayHandle, config: JsonObject) {
  if (!runtime.stateDirectory) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Scoped CodeBuddy requires host-managed storage')
  const home = join(runtime.stateDirectory, 'home'), root = join(runtime.stateDirectory, 'codebuddy')
  await mkdir(home, { recursive: true, mode: 0o700 }); await mkdir(root, { recursive: true, mode: 0o700 })
  const alias = `studio-scoped-${createHash('sha256').update(root).digest('hex').slice(0, 16)}`
  for (const [file, patch] of [
    ['models.json', { models: [{ id: alias, name: gateway.model, vendor: 'Ekko Studio', apiKey: '${EKKO_SCOPED_MODEL_TOKEN}',
      url: `${gateway.baseUrl}/chat/completions`, maxInputTokens: config.contextWindow || 131072, maxOutputTokens: config.outputLimit || 32768,
      supportsToolCall: true, supportsImages: gateway.images === true, relatedModels: { lite: alias, reasoning: alias, subagent: alias } }], availableModels: [alias] }],
    ['settings.json', { model: alias, variantModels: { lite: alias, reasoning: alias } }],
  ] as const) {
    const path = join(root, file), text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return '{}'; throw error })
    let existing: JsonObject
    try { existing = JSON.parse(text); if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new Error() }
    catch { throw new StudioError('INVALID_ARGUMENT', 'Invalid CodeBuddy JSON configuration') }
    await writeFile(`${path}.tmp`, JSON.stringify({ ...existing, ...patch }), { mode: 0o600 }); await rename(`${path}.tmp`, path)
  }
  return { args: ['--model', alias], env: { HOME: home, USERPROFILE: home, CODEBUDDY_CONFIG_DIR: root, EKKO_SCOPED_MODEL_TOKEN: gateway.token,
    CODEBUDDY_MODEL: alias, CODEBUDDY_SMALL_FAST_MODEL: alias, CODEBUDDY_BIG_SLOW_MODEL: alias, CODEBUDDY_CODE_SUBAGENT_MODEL: alias,
    CODEBUDDY_API_KEY: gateway.token, CODEBUDDY_AUTH_TOKEN: '', CODEBUDDY_BASE_URL: gateway.baseUrl, CODEBUDDY_CUSTOM_HEADERS: '' } }
}
