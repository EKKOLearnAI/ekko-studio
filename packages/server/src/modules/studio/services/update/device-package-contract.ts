import { parseSemver } from './version-compare'

export const DEVICE_PACKAGE_ARTIFACT_FORMAT = 'tar.gz'
export const DEFAULT_UPDATE_CHANNEL = 'stable'
export const DEFAULT_RELEASE_MANIFEST_BRANCH = 'release-manifests'
export const DEFAULT_DEVICE_PACKAGE_SOURCE_LABEL = 'Quanthermes Device Releases'
export const DEFAULT_DEVICE_PACKAGE_HEALTHCHECK_URL = 'http://127.0.0.1:6060/health'

export const DEVICE_PACKAGE_REQUIRED_ENTRIES = [
  'dist/',
  'package.json',
  'package-lock.json',
  'scripts/deploy-source-armbian.sh',
  'scripts/install-device-package.sh',
] as const

const CHANNEL_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/

export function normalizeChannelSegment(channel: string): string {
  const normalized = (channel || DEFAULT_UPDATE_CHANNEL).trim() || DEFAULT_UPDATE_CHANNEL
  if (!CHANNEL_SEGMENT_PATTERN.test(normalized)) {
    throw new Error(
      `Invalid update channel "${channel}". Use only letters, numbers, dot, underscore, and dash.`,
    )
  }
  return normalized
}

export function normalizeNodeVersionRange(range: string): string {
  const normalized = (range || '').trim()
  if (!normalized) {
    throw new Error('Node version compatibility range is required.')
  }
  return normalized
}

export function isNodeVersionRangeSatisfied(range: string, nodeVersion: string): boolean {
  const normalizedRange = normalizeNodeVersionRange(range)
  const normalizedVersion = (nodeVersion || '').trim()
  const parsedVersion = parseSemver(normalizedVersion)
  if (!parsedVersion) return false

  const segments = normalizedRange.split(/\s*\|\|\s*/).map(segment => segment.trim()).filter(Boolean)
  return segments.some(segment => isNodeVersionSegmentSatisfied(segment, parsedVersion))
}

function isNodeVersionSegmentSatisfied(
  segment: string,
  nodeVersion: { major: number; minor: number; patch: number },
): boolean {
  const comparators = segment.split(/\s+/).map(part => part.trim()).filter(Boolean)
  return comparators.every(comparator => isNodeComparatorSatisfied(comparator, nodeVersion))
}

function isNodeComparatorSatisfied(
  comparator: string,
  nodeVersion: { major: number; minor: number; patch: number },
): boolean {
  const match = comparator.match(/^(>=|<=|>|<|=|\^|~)?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/)
  if (!match) {
    throw new Error(`Unsupported Node.js compatibility comparator: ${comparator}`)
  }

  const operator = match[1] || '='
  const hasMinor = match[3] != null
  const hasPatch = match[4] != null
  const target = {
    major: Number.parseInt(match[2], 10),
    minor: Number.parseInt(match[3] || '0', 10),
    patch: Number.parseInt(match[4] || '0', 10),
  }
  const compare = compareSemverObjects(nodeVersion, target)

  switch (operator) {
    case '>':
      return compare > 0
    case '>=':
      return compare >= 0
    case '<':
      return compare < 0
    case '<=':
      return compare <= 0
    case '=':
      return compare === 0
    case '^':
      return compare >= 0 && compareSemverObjects(nodeVersion, getCaretUpperBound(target, hasMinor, hasPatch)) < 0
    case '~':
      return compare >= 0 && compareSemverObjects(nodeVersion, getTildeUpperBound(target, hasMinor)) < 0
    default:
      return false
  }
}

function compareSemverObjects(
  a: { major: number; minor: number; patch: number },
  b: { major: number; minor: number; patch: number },
): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  return a.patch - b.patch
}

function getCaretUpperBound(
  target: { major: number; minor: number; patch: number },
  hasMinor: boolean,
  hasPatch: boolean,
): { major: number; minor: number; patch: number } {
  if (target.major > 0 || !hasMinor) {
    return { major: target.major + 1, minor: 0, patch: 0 }
  }
  if (target.minor > 0 || !hasPatch) {
    return { major: target.major, minor: target.minor + 1, patch: 0 }
  }
  return { major: target.major, minor: target.minor, patch: target.patch + 1 }
}

function getTildeUpperBound(
  target: { major: number; minor: number; patch: number },
  hasMinor: boolean,
): { major: number; minor: number; patch: number } {
  if (!hasMinor) {
    return { major: target.major + 1, minor: 0, patch: 0 }
  }
  return { major: target.major, minor: target.minor + 1, patch: 0 }
}
