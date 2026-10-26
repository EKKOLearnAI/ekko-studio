import { getModelApiKey, updateModelApiKey } from '../../repositories/model-api-keys-store'
import { ModelApiError } from './errors'
import { createModelApiKey } from './keys'
import { listApiModels } from './service'

async function keySettings(body: unknown, profiles: string[]) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ModelApiError('Key settings are required.', 400)
  const settings = body as Record<string, unknown>
  if (Object.keys(settings).some(key => !['name', 'models', 'budgetUsd'].includes(key))) throw new ModelApiError('Only name, models and budgetUsd are accepted.', 400)
  const budgetUsd = settings.budgetUsd === undefined ? null : settings.budgetUsd
  if (budgetUsd !== null && (typeof budgetUsd !== 'number' || !Number.isFinite(budgetUsd) || budgetUsd < 0 || budgetUsd > 1_000_000)) {
    throw new ModelApiError('Budget must be null (unlimited) or an amount between 0 and 1000000 USD.', 400, 'budgetUsd')
  }
  if (typeof settings.name !== 'string' || !settings.name.trim() || settings.name.trim().length > 80) {
    throw new ModelApiError('Key name must contain 1–80 characters.', 400, 'name')
  }
  if (!Array.isArray(settings.models) || !settings.models.length || settings.models.some(model => typeof model !== 'string' || !model.trim())) {
    throw new ModelApiError('Select at least one model.', 400, 'models')
  }
  const models = [...new Set(settings.models as string[])]
  const catalog = await listApiModels(profiles)
  const available = new Set(catalog.data.filter(model => model.responses_supported).map(model => model.id))
  if (models.some(model => !available.has(model))) throw new ModelApiError('A selected model is unavailable or not accessible.', 400, 'models')
  return { name: settings.name.trim(), models, budgetUsd }
}

export async function createAccountModelApiKey(userId: number, body: unknown, profiles: string[]) {
  const settings = await keySettings(body, profiles)
  return createModelApiKey(userId, settings.name, settings.models, settings.budgetUsd)
}

export async function editAccountModelApiKey(userId: number, id: string, body: unknown, profiles: string[]) {
  if (!getModelApiKey(userId, id)) throw new ModelApiError('API key not found.', 404)
  const settings = await keySettings(body, profiles)
  const key = updateModelApiKey(userId, id, settings.name, settings.models, settings.budgetUsd)
  if (!key) throw new ModelApiError('API key not found.', 404)
  return { key }
}
