import type { HermesProfile } from '@/api/hermes/profiles'

type ProfileLabelInput = Pick<HermesProfile, 'name'> & {
  displayName?: string | null
  alias?: string | null
}

/** Primary UI label: profile.yaml display_name when set, else canonical id. */
export function profileDisplayLabel(profile: ProfileLabelInput): string {
  const displayName = (profile.displayName || '').trim()
  if (displayName) return displayName
  const alias = (profile.alias || '').trim()
  if (alias) return alias
  return profile.name
}

/** Select / list label with id hint when display_name differs from id. */
export function profileSelectLabel(profile: ProfileLabelInput): string {
  const displayName = (profile.displayName || '').trim()
  if (displayName && displayName !== profile.name) {
    return `${displayName} (${profile.name})`
  }
  return profileDisplayLabel(profile)
}
