import { getActiveProfileName, getProfileDir } from '../profiles/profile'
import { execHermes } from '../runtime/process'

const JOURNEY_TIMEOUT_MS = 10000
const JOURNEY_MIN_HERMES_VERSION = '0.18.0'
const JOURNEY_UNSUPPORTED_MESSAGE = `Please update Hermes to ${JOURNEY_MIN_HERMES_VERSION} or later to use Learning Journey.`

export interface JourneyNode {
  id: string
  label: string
  kind: 'skill' | 'memory' | string
  timestamp?: number | null
  category?: string | null
  useCount?: number
  state?: string
  createdBy?: string | null
  pinned?: boolean
  memorySource?: string
}

export interface JourneyEdge {
  source: string
  target: string
}

export interface JourneyCluster {
  category: string
  count: number
}

export interface JourneyMemory {
  source?: string
  timestamp?: number | null
  title?: string
  body?: string
}

export interface JourneyGraph {
  nodes: JourneyNode[]
  edges: JourneyEdge[]
  clusters: JourneyCluster[]
  memory?: JourneyMemory[]
  stats?: Record<string, unknown>
}

export interface JourneyGraphResponse {
  profile: string
  source: 'cli'
  graph: JourneyGraph
}

function normalizeProfile(profile?: string | null): string {
  const value = typeof profile === 'string' ? profile.trim() : ''
  return value || getActiveProfileName() || 'default'
}

function parseJourneyGraph(stdout: string): JourneyGraph {
  const trimmed = stdout
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .trim()
  if (!trimmed) throw new Error('Hermes journey returned empty output')

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (err) {
    throw new Error(`Hermes journey returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Hermes journey returned a non-object JSON payload')
  }

  const graph = parsed as Partial<JourneyGraph>
  return {
    nodes: Array.isArray(graph.nodes) ? graph.nodes : [],
    edges: Array.isArray(graph.edges) ? graph.edges : [],
    clusters: Array.isArray(graph.clusters) ? graph.clusters : [],
    memory: Array.isArray(graph.memory) ? graph.memory : [],
    stats: graph.stats && typeof graph.stats === 'object' ? graph.stats : {},
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const stderr = typeof (err as Error & { stderr?: unknown }).stderr === 'string'
      ? String((err as Error & { stderr?: string }).stderr).trim()
      : ''
    const stdout = typeof (err as Error & { stdout?: unknown }).stdout === 'string'
      ? String((err as Error & { stdout?: string }).stdout).trim()
      : ''
    return stderr || stdout || err.message
  }
  return String(err)
}

function isUnsupportedJourneyCommandError(message: string): boolean {
  return /journey/i.test(message) && (
    /invalid choice/i.test(message) ||
    /unknown command/i.test(message) ||
    /no such command/i.test(message) ||
    /unrecognized command/i.test(message) ||
    /unexpected argument/i.test(message) ||
    /unrecognized arguments?/i.test(message)
  )
}

export async function getJourneyGraph(profile?: string | null): Promise<JourneyGraphResponse> {
  const profileName = normalizeProfile(profile)
  const profileDir = getProfileDir(profileName)

  let stdout: string
  try {
    const result = await execHermes(['journey', '--json', '--no-color'], {
      timeout: JOURNEY_TIMEOUT_MS,
      env: {
        ...process.env,
        HERMES_HOME: profileDir,
      },
    })
    stdout = result.stdout
  } catch (err) {
    const message = errorMessage(err)
    if (isUnsupportedJourneyCommandError(message)) {
      throw new Error(JOURNEY_UNSUPPORTED_MESSAGE)
    }
    throw new Error(`Failed to load Hermes journey graph: ${message}`)
  }

  try {
    return {
      profile: profileName,
      source: 'cli',
      graph: parseJourneyGraph(stdout),
    }
  } catch (err) {
    throw new Error(`Failed to load Hermes journey graph: ${errorMessage(err)}`)
  }
}
