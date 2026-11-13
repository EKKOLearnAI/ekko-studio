import type { Context } from 'koa'
import * as service from '../services/group-chat/documents'

export async function uploadDocument(ctx: Context): Promise<void> {
  await service.uploadDocument(ctx)
}

export async function getDocumentProgress(ctx: Context): Promise<void> {
  await service.getDocumentProgress(ctx)
}

export async function listDocuments(ctx: Context): Promise<void> {
  await service.listDocuments(ctx)
}

export async function startDocumentReading(ctx: Context): Promise<void> {
  await service.startDocumentReading(ctx)
}
