import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'

const MASK = '••••••••'
const secret = /(?:api.?key|token|secret|password|authorization|cookie)$/i
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
export const accountKey = identity => createHash('sha256').update(JSON.stringify([identity.userId, identity.profile])).digest('hex')
export const settingsStore = (ctx, identity) => ctx.storage.namespace('accounts', accountKey(identity))
export async function readSettings(ctx, identity) {
  return await settingsStore(ctx, identity).get('settings') || { executable: '', defaultModel: '', models: { providers: {} }, config: {} }
}
export function maskSecrets(value) {
  if (Array.isArray(value)) return value.map(maskSecrets)
  if (!plain(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secret.test(key) && typeof item === 'string' && item ? MASK : maskSecrets(item)]))
}
function mergeSecrets(value, old) {
  if (Array.isArray(value)) return value.map((item, index) => mergeSecrets(item, item?.id ? old?.find?.(other => other?.id === item.id) : old?.[index]))
  if (!plain(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Invalid configuration key')
    if (secret.test(key) && item === MASK) {
      if (typeof old?.[key] !== 'string') throw new Error(`Enter a value for ${key}`)
      return [key, old[key]]
    }
    return [key, mergeSecrets(item, old?.[key])]
  }))
}
export async function saveSettings(ctx, identity, input) {
  if (!plain(input) || typeof input.executable !== 'string' || typeof input.defaultModel !== 'string') throw new Error('Invalid OMP settings')
  if (input.executable && (!isAbsolute(input.executable) || input.executable.length > 2048)) throw new Error('OMP executable must be an absolute path')
  if (input.defaultModel.length > 500 || input.defaultModel && !input.defaultModel.includes('/')) throw new Error('Use provider/model for the native model')
  if (!plain(input.models) || !plain(input.models.providers) || !plain(input.config)) throw new Error('Models require a providers object; OMP settings require an object')
  if (Buffer.byteLength(JSON.stringify(input)) > 500000) throw new Error('OMP configuration is too large')
  const old = await readSettings(ctx, identity)
  const value = { executable: input.executable.trim(), defaultModel: input.defaultModel.trim(), models: mergeSecrets(input.models, old.models), config: mergeSecrets(input.config, old.config) }
  await settingsStore(ctx, identity).set('settings', value)
  return { ok: true }
}
