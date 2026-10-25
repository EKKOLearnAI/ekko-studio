import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { AgentProviderRef } from '../../contracts/plugins'
import type { AgentInstance } from '../../repositories/agent-execution-store'

/** Keep legacy paths; compatible revisions explicitly retain their original state revision. */
export async function agentStateDirectory(root: string, instance: AgentInstance, provider: AgentProviderRef, stateRevision = instance.revision): Promise<string> {
  const identity = provider.kind === 'plugin' ? ['plugin', provider.pluginId, provider.version] : ['builtin', provider.module, provider.implementationVersion]
  const key = createHash('sha256').update(JSON.stringify([instance.ownerId, instance.profileId, instance.id, stateRevision, identity])).digest('hex')
  const path = resolve(root, key)
  await mkdir(path, { recursive: true, mode: 0o700 })
  return path
}
