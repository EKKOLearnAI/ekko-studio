import type { DatabaseSync } from 'node:sqlite'
import sharp, { type Metadata } from 'sharp'
import { StudioError, type AgentRunInput, type ArtifactChunk, type ExecutionScope, type ImageArtifact } from '../../contracts/plugins'
import { jsonCopy } from '../plugins/validation'
import { AgentArtifactStore } from '../../repositories/agent-artifact-store'
import type { AgentExecutionStore } from '../../repositories/agent-execution-store'

export const MAX_AGENT_IMAGE_BYTES = 4 * 1024 * 1024
const CHUNK_BYTES = 192 * 1024
const mediaTypes: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }

/** Authorizes immutable images before admission and on each bounded Run read. */
export class AgentArtifacts {
  private uploading = 0
  private readonly store: AgentArtifactStore
  constructor(db: DatabaseSync, private readonly runs: AgentExecutionStore,
    private readonly authorize: (scope: ExecutionScope) => void) { this.store = new AgentArtifactStore(db) }


  async create(scope: ExecutionScope, bytes: Uint8Array, signal: AbortSignal): Promise<ImageArtifact> {
    scope = jsonCopy(scope)
    this.authorize(scope)
    if (scope.sessionId || scope.runId || scope.workspaceId) throw new StudioError('FORBIDDEN', 'Image upload requires an unbound user scope')
    if (!bytes.length || bytes.length > MAX_AGENT_IMAGE_BYTES) throw new StudioError('RESOURCE_EXHAUSTED', 'Image must be between 1 byte and 4 MiB')
    if (this.uploading >= 4) throw new StudioError('RESOURCE_EXHAUSTED', 'Image validation is busy')
    const data = Buffer.from(bytes)
    this.uploading++
    try {
      if (signal.aborted) throw new StudioError('CANCELLED', 'Image upload ended')
      let metadata: Metadata
      try { metadata = await sharp(data, { limitInputPixels: 40_000_000, failOn: 'warning' }).metadata() }
      catch { throw new StudioError('INVALID_ARGUMENT', 'Invalid or oversized image') }
      const mediaType = mediaTypes[metadata.format || '']
      if (!mediaType || !metadata.width || !metadata.height || metadata.width * metadata.height > 40_000_000
        || (metadata.pages || 1) > 1) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Only single-frame PNG, JPEG, WebP and GIF images are supported')
      try { await sharp(data, { limitInputPixels: 40_000_000, failOn: 'warning' }).stats() }
      catch { throw new StudioError('INVALID_ARGUMENT', 'Invalid image pixels') }
      this.authorize(scope)
      if (signal.aborted) throw new StudioError('CANCELLED', 'Image upload ended')
      return this.store.create(scope.principal.id, scope.profileId, mediaType, data)
    } finally { this.uploading-- }
  }

  validate(scope: ExecutionScope, input: AgentRunInput): void {
    this.authorize(scope)
    let count = 0, bytes = 0
    for (const block of input.content) {
      if (block.type !== 'image') continue
      const artifact = this.metadata(scope, block.artifactId)
      if (artifact.mediaType !== block.mediaType) throw new StudioError('INVALID_ARGUMENT', 'Image media type does not match the artifact')
      bytes += artifact.byteLength
      if (++count > 8 || bytes > 6 * 1024 * 1024) throw new StudioError('RESOURCE_EXHAUSTED', 'Run image limit exceeded')
    }
  }

  read(scope: ExecutionScope, id: string, offset = 0): ArtifactChunk {
    this.authorize(scope)
    if (!Number.isSafeInteger(offset) || offset < 0) throw new StudioError('INVALID_ARGUMENT', 'Invalid image offset')
    const run = scope.runId ? this.runs.get(scope.runId) : null
    if (!run || run.ownerId !== scope.principal.id || run.profileId !== scope.profileId
      || !['running', 'waiting_input'].includes(run.status)
      || !this.runs.input(run.id)?.content.some(block => block.type === 'image' && block.artifactId === id)) {
      throw new StudioError('FORBIDDEN', 'Image is not attached to the current live Run')
    }
    const artifact = this.metadata(scope, id)
    if (offset >= artifact.byteLength) throw new StudioError('INVALID_ARGUMENT', 'Image offset exceeds its length')
    const chunk = this.store.chunk(id, offset, CHUNK_BYTES)
    const nextOffset = offset + chunk.length
    return { ...artifact, offset, data: chunk.toString('base64'), nextOffset, done: nextOffset === artifact.byteLength }
  }

  remove(scope: ExecutionScope, id: string): void {
    this.metadata(scope, id)
    this.store.removeUnused(id)
  }

  /** Caller must first authorize the current owned chat binding. Accepted
   * original/effective references survive native completion and SQLite restore. */
  readForChat(scope: ExecutionScope, sessionId: string, id: string): { mediaType: string; bytes: Buffer } {
    this.authorize(scope)
    if (scope.sessionId !== undefined && scope.sessionId !== sessionId) throw new StudioError('FORBIDDEN', 'Image is outside the execution scope')
    const image = this.metadata(scope, id)
    if (!this.store.referencedByChat(scope.principal.id, scope.profileId, sessionId, id)) throw new StudioError('NOT_FOUND', 'Image is not attached to this chat')
    return { mediaType: image.mediaType, bytes: this.store.chunk(id, 0, image.byteLength) }
  }

  private metadata(scope: ExecutionScope, id: string): ImageArtifact {
    this.authorize(scope)
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new StudioError('INVALID_ARGUMENT', 'Invalid image artifact id')
    const artifact = this.store.metadata(scope.principal.id, scope.profileId, id)
    if (!artifact) throw new StudioError('NOT_FOUND', 'Image artifact is unavailable')
    return artifact
  }
}
