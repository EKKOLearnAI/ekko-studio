import type { Context } from 'koa'
import * as updates from '../services/update/version-preview-manager'

export async function handleUpdate(ctx: Context): Promise<void> {
  await updates.handleUpdate(ctx)
}

export async function reconcileUpdate(ctx: Context): Promise<void> {
  await updates.reconcileUpdate(ctx)
}

export async function getUpdateEnvironment(ctx: Context): Promise<void> {
  await updates.getUpdateEnvironment(ctx)
}

export async function updateStatus(ctx: Context): Promise<void> {
  await updates.updateStatus(ctx)
}

export async function updateCapabilities(ctx: Context): Promise<void> {
  await updates.updateCapabilities(ctx)
}

export async function getUpdateIdentity(ctx: Context): Promise<void> {
  await updates.getUpdateIdentity(ctx)
}

export async function repairUpdateIdentity(ctx: Context): Promise<void> {
  await updates.repairUpdateIdentity(ctx)
}

export async function clearStaleUpdateStatus(ctx: Context): Promise<void> {
  await updates.clearStaleUpdateStatus(ctx)
}

export async function previewStatus(ctx: Context): Promise<void> {
  await updates.previewStatus(ctx)
}

export async function previewTags(ctx: Context): Promise<void> {
  await updates.previewTags(ctx)
}

export async function preparePreview(ctx: Context): Promise<void> {
  await updates.preparePreview(ctx)
}

export async function installPreview(ctx: Context): Promise<void> {
  await updates.installPreview(ctx)
}

export async function startPreview(ctx: Context): Promise<void> {
  await updates.startPreview(ctx)
}

export async function stopPreview(ctx: Context): Promise<void> {
  await updates.stopPreview(ctx)
}
