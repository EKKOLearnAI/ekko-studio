import type { Middleware } from 'koa'
import { LEGACY_PROVIDER_CREDENTIAL, stripLegacyProviderCredential } from '../contracts/legacy-provider-credential'

const credentialInputPath = /^\/api\/(?:hermes\/(?:config\/providers(?:\/|$)|provider-models$)|studio\/(?:sessions|chat-run)(?:\/|$))/

function legacyGroups(groups: any[]): any[] {
  return groups.map(group => ({ ...group,
    api_key: group.credential_configured === true ? LEGACY_PROVIDER_CREDENTIAL : '',
  }))
}

/** Keep the compatibility shape at HTTP boundaries, outside the internal catalog. */
export const legacyProviderCredentials: Middleware = async (ctx, next) => {
  if (credentialInputPath.test(ctx.path)) stripLegacyProviderCredential(ctx.request.body)
  await next()
  if (ctx.method !== 'GET' || ctx.path !== '/api/hermes/available-models' || ctx.status !== 200) return
  // A query parameter survives older relay header allowlists as well.
  if (ctx.query.credential_format === 'metadata') return
  const body = ctx.body as any
  if (!Array.isArray(body?.groups)) return
  ctx.body = { ...body,
    groups: legacyGroups(body.groups),
    ...(Array.isArray(body.profiles) ? { profiles: body.profiles.map((profile: any) => ({ ...profile,
      groups: legacyGroups(profile.groups || []),
    })) } : {}),
  }
}
