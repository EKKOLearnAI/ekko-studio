import type { Context } from 'koa'
import { StudioError } from '../contracts/plugins'
import { executionScope, respond } from './studio-plugins'
import { getStudioPluginRuntime } from '../services/plugins/runtime'
import { MAX_SKILL_IMPORT_BYTES } from '../services/agents/resource-skill-archive'
import { nonDestroyingRequestBody, drainRejectedRequest } from '../http/request-body'
import { parseResourceSkillUpload } from '../http/resource-skill-upload'

let uploading = 0
export const importAgentSkill = (ctx: Context) => respond(ctx, async () => {
  const scope = executionScope(ctx), coordinator = getStudioPluginRuntime().coordinator
  coordinator.authorizeResourceUpload(scope, ctx.params.id)
  if (uploading >= 4) throw new StudioError('RESOURCE_EXHAUSTED', 'Skill uploads are busy')
  uploading++
  const controller = new AbortController(), abort = () => controller.abort()
  ctx.res.once('close', abort)
  try {
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of nonDestroyingRequestBody(ctx.req)) {
      bytes += chunk.length
      if (bytes > MAX_SKILL_IMPORT_BYTES + 2_097_152) {
        await drainRejectedRequest(ctx.req)
        throw new StudioError('RESOURCE_EXHAUSTED', 'Skill upload exceeds 16 MiB')
      }
      chunks.push(chunk)
    }
    if (controller.signal.aborted) throw new StudioError('CANCELLED', 'Skill upload cancelled')
    const input = parseResourceSkillUpload(ctx.get('content-type'), Buffer.concat(chunks))
    return coordinator.importSkill(scope, ctx.params.id, input.revision, input.snapshot, input.locationId, input.uploads, controller.signal)
  } finally { uploading--; ctx.res.removeListener('close', abort) }
})
