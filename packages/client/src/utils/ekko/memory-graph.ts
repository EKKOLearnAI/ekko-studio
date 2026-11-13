import type { EkkoMemoryNode } from '@/api/ekko/memory'

export type EkkoMemoryRelationshipKind = 'revision' | 'source' | 'entity'

export interface EkkoMemoryGraphEdge {
  id: string
  source: string
  target: string
  kinds: EkkoMemoryRelationshipKind[]
  labels: string[]
}

export interface EkkoMemoryLayoutNode {
  id: string
  degree: number
  position: {
    x: number
    y: number
  }
}

export interface EkkoMemoryLayoutOptions {
  startX?: number
  startY?: number
  columnGap?: number
  verticalGap?: number
  componentGap?: number
  maxRows?: number
}

const RELATIONSHIP_ORDER: EkkoMemoryRelationshipKind[] = ['revision', 'source', 'entity']

function scopeKey(node: EkkoMemoryNode): string {
  const scope = node.scope || { type: 'profile' as const }
  if (scope.type === 'profile') return 'profile'
  if (scope.type === 'session') return `session:${scope.id}`
  return `context:${scope.namespace}:${scope.id}`
}

function compareNodes(a: EkkoMemoryNode, b: EkkoMemoryNode): number {
  const aTime = Date.parse(a.createdAt || a.updatedAt) || 0
  const bTime = Date.parse(b.createdAt || b.updatedAt) || 0
  if (aTime !== bTime) return aTime - bTime
  if (a.revision !== b.revision) return a.revision - b.revision
  return a.id.localeCompare(b.id)
}

function normalizedPair(source: string, target: string): string {
  return source < target ? `${source}\u0000${target}` : `${target}\u0000${source}`
}

function uniqueStrings(values: string[] | undefined): string[] {
  return [...new Set((values || []).map(value => String(value).trim()).filter(Boolean))]
}

/**
 * Builds explainable links only: explicit/fallback revision lineage, memories
 * extracted from the same message, and memories that name the same entity.
 * Source/entity groups are chained chronologically instead of becoming dense
 * cliques, keeping large memory sets readable.
 */
export function buildEkkoMemoryGraphEdges(nodes: EkkoMemoryNode[]): EkkoMemoryGraphEdge[] {
  const nodeById = new Map(nodes.map(node => [node.id, node]))
  const edgeByPair = new Map<string, EkkoMemoryGraphEdge>()

  const addRelation = (
    source: string,
    target: string,
    kind: EkkoMemoryRelationshipKind,
    label?: string,
  ) => {
    if (source === target || !nodeById.has(source) || !nodeById.has(target)) return
    const pair = normalizedPair(source, target)
    const current = edgeByPair.get(pair)
    if (current) {
      if (!current.kinds.includes(kind)) current.kinds.push(kind)
      if (label && !current.labels.includes(label)) current.labels.push(label)
      current.kinds.sort((a, b) => RELATIONSHIP_ORDER.indexOf(a) - RELATIONSHIP_ORDER.indexOf(b))
      current.labels.sort((a, b) => a.localeCompare(b))
      return
    }
    const [firstId, secondId] = pair.split('\u0000')
    edgeByPair.set(pair, {
      id: `memory-edge:${encodeURIComponent(firstId)}:${encodeURIComponent(secondId)}`,
      source,
      target,
      kinds: [kind],
      labels: label ? [label] : [],
    })
  }

  for (const node of [...nodes].sort(compareNodes)) {
    const predecessor = node.supersedesId || node.parentId
    if (predecessor) addRelation(predecessor, node.id, 'revision')
  }

  const slotGroups = new Map<string, EkkoMemoryNode[]>()
  for (const node of nodes) {
    const key = `${scopeKey(node)}\u0000${node.key}`
    slotGroups.set(key, [...(slotGroups.get(key) || []), node])
  }
  for (const group of slotGroups.values()) {
    const ordered = [...group].sort(compareNodes)
    for (let index = 1; index < ordered.length; index += 1) {
      addRelation(ordered[index - 1].id, ordered[index].id, 'revision')
    }
  }

  const connectSharedValues = (
    valuesForNode: (node: EkkoMemoryNode) => string[],
    kind: 'source' | 'entity',
  ) => {
    const groups = new Map<string, { label: string; nodes: EkkoMemoryNode[] }>()
    for (const node of nodes) {
      for (const label of uniqueStrings(valuesForNode(node))) {
        const normalized = label.toLocaleLowerCase()
        const current = groups.get(normalized) || { label, nodes: [] }
        if (label < current.label) current.label = label
        current.nodes.push(node)
        groups.set(normalized, current)
      }
    }
    for (const group of groups.values()) {
      const ordered = [...new Map(group.nodes.map(node => [node.id, node])).values()].sort(compareNodes)
      for (let index = 1; index < ordered.length; index += 1) {
        addRelation(ordered[index - 1].id, ordered[index].id, kind, group.label)
      }
    }
  }

  connectSharedValues(node => node.sourceMessageIds, 'source')
  connectSharedValues(node => node.entities, 'entity')

  return [...edgeByPair.values()].sort((a, b) => a.id.localeCompare(b.id))
}

function neighborMap(nodes: EkkoMemoryNode[], edges: EkkoMemoryGraphEdge[]): Map<string, Set<string>> {
  const ids = new Set(nodes.map(node => node.id))
  const neighbors = new Map(nodes.map(node => [node.id, new Set<string>()]))
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue
    neighbors.get(edge.source)?.add(edge.target)
    neighbors.get(edge.target)?.add(edge.source)
  }
  return neighbors
}

function connectedComponents(
  nodes: EkkoMemoryNode[],
  neighbors: Map<string, Set<string>>,
): EkkoMemoryNode[][] {
  const nodeById = new Map(nodes.map(node => [node.id, node]))
  const visited = new Set<string>()
  const components: EkkoMemoryNode[][] = []
  for (const start of [...nodes].sort(compareNodes)) {
    if (visited.has(start.id)) continue
    const queue = [start.id]
    const component: EkkoMemoryNode[] = []
    visited.add(start.id)
    while (queue.length) {
      const id = queue.shift()!
      const node = nodeById.get(id)
      if (node) component.push(node)
      const adjacent = [...(neighbors.get(id) || [])]
        .map(neighborId => nodeById.get(neighborId))
        .filter((value): value is EkkoMemoryNode => Boolean(value))
        .sort(compareNodes)
      for (const neighbor of adjacent) {
        if (visited.has(neighbor.id)) continue
        visited.add(neighbor.id)
        queue.push(neighbor.id)
      }
    }
    components.push(component.sort(compareNodes))
  }
  return components.sort((a, b) => {
    if (a.length !== b.length) return b.length - a.length
    return compareNodes(a[0], b[0])
  })
}

/** Deterministic component layout with chronological relationship flow. */
export function layoutEkkoMemoryGraph(
  nodes: EkkoMemoryNode[],
  edges: EkkoMemoryGraphEdge[],
  options: EkkoMemoryLayoutOptions = {},
): EkkoMemoryLayoutNode[] {
  const startX = options.startX ?? 72
  const startY = options.startY ?? 44
  const columnGap = options.columnGap ?? 318
  const verticalGap = options.verticalGap ?? 142
  const componentGap = options.componentGap ?? 76
  const maxRows = Math.max(1, options.maxRows ?? 6)
  const nodeById = new Map(nodes.map(node => [node.id, node]))
  const neighbors = neighborMap(nodes, edges)
  const components = connectedComponents(nodes, neighbors)
  const result: EkkoMemoryLayoutNode[] = []
  let componentY = startY

  for (const component of components.filter(group => group.length > 1)) {
    const componentIds = new Set(component.map(node => node.id))
    const rank = new Map<string, number>()
    for (const node of component) {
      const incoming = edges
        .filter(edge => edge.target === node.id && componentIds.has(edge.source))
        .map(edge => rank.get(edge.source))
        .filter((value): value is number => value !== undefined)
      rank.set(node.id, incoming.length ? Math.max(...incoming) + 1 : 0)
    }
    const ranked = new Map<number, EkkoMemoryNode[]>()
    for (const node of component) {
      const nodeRank = rank.get(node.id) || 0
      ranked.set(nodeRank, [...(ranked.get(nodeRank) || []), node])
    }
    const maxRankRows = Math.max(...[...ranked.values()].map(group => group.length))
    for (const [nodeRank, group] of [...ranked.entries()].sort(([a], [b]) => a - b)) {
      group.sort(compareNodes).forEach((node, row) => {
        result.push({
          id: node.id,
          degree: neighbors.get(node.id)?.size || 0,
          position: {
            x: startX + nodeRank * columnGap,
            y: componentY + row * verticalGap,
          },
        })
      })
    }
    componentY += Math.max(1, maxRankRows) * verticalGap + componentGap
  }

  const isolated = components.filter(group => group.length === 1).flat()
  isolated.forEach((node, index) => {
    const column = Math.floor(index / maxRows)
    const row = index % maxRows
    result.push({
      id: node.id,
      degree: 0,
      position: {
        x: startX + column * columnGap,
        y: componentY + row * verticalGap,
      },
    })
  })

  return result.filter(item => nodeById.has(item.id))
}

export function ekkoMemoryNeighborIds(nodeId: string, edges: EkkoMemoryGraphEdge[]): Set<string> {
  const neighbors = new Set<string>()
  for (const edge of edges) {
    if (edge.source === nodeId) neighbors.add(edge.target)
    if (edge.target === nodeId) neighbors.add(edge.source)
  }
  return neighbors
}
