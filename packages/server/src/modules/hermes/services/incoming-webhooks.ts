import { randomBytes } from 'crypto'
import { chmod } from 'fs/promises'
import { join } from 'path'
import { readConfigYamlForProfile, updateConfigYamlForProfile } from './profiles/config'
import { safeFileStore } from '../../studio/public/safe-file-store'
import { getProfileDir } from './profiles/profile'
import { getGatewayRuntimeStatusForProfile, restartGatewayForProfile } from './gateway/autostart'

export interface IncomingWebhookSubscription {
  name: string
  description: string
  events: string[]
  deliver: string
  deliver_only: boolean
  prompt: string
  skills: string[]
  created_at?: string
  enabled: boolean
  secret_set: boolean
  url: string
}

type SubscriptionStore = Record<string, Record<string, any>>

function subscriptionsPath(profile: string): string {
  return join(getProfileDir(profile), 'webhook_subscriptions.json')
}

async function readSubscriptions(profile: string): Promise<SubscriptionStore> {
  try {
    const raw = await safeFileStore.readText(subscriptionsPath(profile))
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (error: any) {
    if (error?.code === 'ENOENT') return {}
    throw error
  }
}

async function updateSubscriptions<T>(profile: string, updater: (current: SubscriptionStore) => { data: SubscriptionStore; result: T }): Promise<T> {
  const filePath = subscriptionsPath(profile)
  const result = await safeFileStore.updateText<T>(filePath, (raw) => {
    let current: SubscriptionStore = {}
    if (raw.trim()) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed
    }
    const updated = updater(current)
    return { content: `${JSON.stringify(updated.data, null, 2)}\n`, result: updated.result }
  }, { backup: true })
  await chmod(filePath, 0o600).catch(() => undefined)
  return result as T
}

function cleanName(value: unknown): string {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '-')
}

function assertName(name: string): void {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw new Error('Invalid name. Use lowercase letters, numbers, hyphens, or underscores.')
  }
}

function routeBelongsToProfile(route: Record<string, any>, profile: string, unified: boolean): boolean {
  if (!unified) return true
  return String(route.profile || 'default').trim() === profile
}

function displayHost(value: unknown): string {
  const host = String(value || '').trim()
  if (!host || host === '0.0.0.0' || host === '::') return 'localhost'
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

async function contextForProfile(profile: string) {
  const runtime = await getGatewayRuntimeStatusForProfile(profile)
  const storageProfile = runtime.targetProfile || profile
  const config = await readConfigYamlForProfile(storageProfile)
  const webhook = config.platforms?.webhook || {}
  const extra = webhook.extra || {}
  const baseUrl = `http://${displayHost(extra.host)}:${Number(extra.port) || 8644}`
  const prefix = runtime.unified && profile !== 'default' ? `/p/${encodeURIComponent(profile)}` : ''
  return { runtime, storageProfile, config, webhook, baseUrl, prefix }
}

function validateDeliveryTarget(config: Record<string, any>, deliver: string, chatId: string): void {
  if (deliver === 'log') return
  const platform = config.platforms?.[deliver]
  if (!platform || platform.enabled !== true) {
    throw new Error(`Delivery channel "${deliver}" is not enabled for this profile.`)
  }
  if (!chatId && !String(platform.home_channel?.chat_id || '').trim()) {
    throw new Error(`Delivery channel "${deliver}" has no home destination. Enter a destination chat ID.`)
  }
}

export async function listIncomingWebhooks(profile: string) {
  const context = await contextForProfile(profile)
  const subscriptions = await readSubscriptions(context.storageProfile)
  return {
    profile,
    enabled: context.webhook.enabled === true,
    gateway_running: context.runtime.running,
    unified: !!context.runtime.unified,
    base_url: `${context.baseUrl}${context.prefix}`,
    subscriptions: Object.entries(subscriptions)
      .filter(([, route]) => routeBelongsToProfile(route, profile, !!context.runtime.unified))
      .map(([name, route]): IncomingWebhookSubscription => ({
        name,
        description: String(route.description || ''),
        events: Array.isArray(route.events) ? route.events.map(String) : [],
        deliver: String(route.deliver || 'log'),
        deliver_only: route.deliver_only === true,
        prompt: String(route.prompt || ''),
        skills: Array.isArray(route.skills) ? route.skills.map(String) : [],
        created_at: route.created_at ? String(route.created_at) : undefined,
        enabled: route.enabled !== false,
        secret_set: !!route.secret,
        url: `${context.baseUrl}${context.prefix}/webhooks/${encodeURIComponent(name)}`,
      })),
  }
}

export async function enableIncomingWebhooks(profile: string) {
  const context = await contextForProfile(profile)
  await updateConfigYamlForProfile(context.storageProfile, (config) => {
    config.platforms ||= {}
    config.platforms.webhook ||= {}
    config.platforms.webhook.enabled = true
    config.platforms.webhook.extra ||= {}
    return config
  })
  return restartGatewayForProfile(profile)
}

export async function createIncomingWebhook(profile: string, input: Record<string, any>) {
  const context = await contextForProfile(profile)
  if (context.webhook.enabled !== true) throw new Error('Incoming webhooks are not enabled for this gateway.')
  const name = cleanName(input.name)
  assertName(name)
  const secret = randomBytes(32).toString('base64url')
  const events = Array.isArray(input.events) ? input.events.map((item: unknown) => String(item).trim()).filter(Boolean) : []
  const skills = Array.isArray(input.skills) ? input.skills.map((item: unknown) => String(item).trim()).filter(Boolean) : []
  const deliver = String(input.deliver || 'log').trim() || 'log'
  const deliverChatId = String(input.deliver_chat_id || '').trim()
  if (input.deliver_only === true && deliver === 'log') throw new Error('Direct delivery requires a real destination.')
  validateDeliveryTarget(context.config, deliver, deliverChatId)

  await updateSubscriptions(context.storageProfile, (current) => {
    if (current[name]) throw new Error(`A webhook named "${name}" already exists.`)
    current[name] = {
      description: String(input.description || '').trim() || `Studio subscription: ${name}`,
      events,
      secret,
      prompt: String(input.prompt || '').trim(),
      skills,
      deliver,
      ...(deliverChatId ? { deliver_extra: { chat_id: deliverChatId } } : {}),
      ...(input.deliver_only === true ? { deliver_only: true } : {}),
      ...(context.runtime.unified ? { profile } : {}),
      created_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    }
    return { data: current, result: undefined }
  })
  return { ...(await listIncomingWebhooks(profile)).subscriptions.find(item => item.name === name), secret }
}

export async function setIncomingWebhookEnabled(profile: string, nameValue: string, enabled: boolean) {
  const context = await contextForProfile(profile)
  const name = cleanName(nameValue)
  await updateSubscriptions(context.storageProfile, (current) => {
    const route = current[name]
    if (!route || !routeBelongsToProfile(route, profile, !!context.runtime.unified)) throw new Error('Incoming webhook not found.')
    route.enabled = enabled
    return { data: current, result: undefined }
  })
}

export async function removeIncomingWebhook(profile: string, nameValue: string) {
  const context = await contextForProfile(profile)
  const name = cleanName(nameValue)
  await updateSubscriptions(context.storageProfile, (current) => {
    const route = current[name]
    if (!route || !routeBelongsToProfile(route, profile, !!context.runtime.unified)) throw new Error('Incoming webhook not found.')
    delete current[name]
    return { data: current, result: undefined }
  })
}
