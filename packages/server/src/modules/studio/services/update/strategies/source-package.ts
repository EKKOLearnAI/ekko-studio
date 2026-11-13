import { UpdateError } from '../errors'
import type { SourcePackageManifest } from '../types'
import { compareSemver } from '../version-compare'

export function assertSourcePackageCompatibility(
  manifest: SourcePackageManifest,
  currentVersion: string,
): void {
  const minCompare = compareSemver(currentVersion, manifest.minCurrentVersion)
  if (minCompare == null) {
    throw new UpdateError(
      'update_manifest_invalid',
      `Cannot compare current version ${currentVersion} with manifest minCurrentVersion ${manifest.minCurrentVersion}.`,
    )
  }
  if (minCompare < 0) {
    throw new UpdateError(
      'update_incompatible_current_version',
      `Current version ${currentVersion} is below the minimum supported update version ${manifest.minCurrentVersion}.`,
      409,
    )
  }
}