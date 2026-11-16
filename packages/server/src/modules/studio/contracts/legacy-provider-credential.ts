/** Non-secret readiness marker for clients that predate credential_configured.
 * This is never a credential accepted by the gateway or an upstream provider.
 */
export const LEGACY_PROVIDER_CREDENTIAL = '__studio_managed_credential__'

/** Only transport credential fields are stripped; user input is left intact. */
export function stripLegacyProviderCredential(payload: unknown): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return
  const data = payload as Record<string, unknown>
  for (const field of ['api_key', 'apiKey']) {
    if (typeof data[field] === 'string' && data[field].trim() === LEGACY_PROVIDER_CREDENTIAL) {
      delete data[field]
      if (field === 'api_key' && data.credential_action === 'replace') data.credential_action = 'keep'
    }
  }
}
