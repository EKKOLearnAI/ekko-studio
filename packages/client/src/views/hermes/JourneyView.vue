<script setup lang="ts">
import PageLoading from '@/components/common/PageLoading.vue'
import PageHeader from '@/components/layout/PageHeader.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NDrawer, NDrawerContent, NTag, useMessage } from 'naive-ui'
import {
  Handle,
  MarkerType,
  Position,
  VueFlow,
  useVueFlow,
} from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import { useI18n } from 'vue-i18n'
import { fetchJourneyGraph, type JourneyGraphResponse, type JourneyMemory, type JourneyNode } from '@/api/hermes/journey'
import { fetchSkills, type SkillsData } from '@/api/hermes/skills'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { normalizeSkillDescription, skillDescriptionPreview } from '@/utils/hermes/skill-display'
import { journeyNeighborIds, layoutJourneyGraph } from '@/utils/hermes/journey-layout'

import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
import '@vue-flow/minimap/dist/style.css'

type SkillDescriptionLoadState = 'idle' | 'loading' | 'loaded' | 'failed'

interface JourneyFlowNodeData {
  node: JourneyNode
  column: 'memory' | 'skill'
  degree: number
  color: string
  categoryLabel: string
  timestampLabel: string
  kindLabel: string
  active: boolean
  related: boolean
  dimmed: boolean
}

const CATEGORY_PALETTE = [
  '#4f8cff',
  '#ff4fa3',
  '#38c976',
  '#f6c542',
  '#9b6cff',
  '#ff7a45',
  '#22c7d8',
  '#e84d5b',
  '#7cb342',
  '#d66efd',
  '#00a884',
  '#ff9f1a',
]

const { t } = useI18n()
const message = useMessage()
const profilesStore = useProfilesStore()
const { fitView } = useVueFlow('hermes-journey')

const data = ref<JourneyGraphResponse | null>(null)
const loading = ref(true)
const graphWrapRef = ref<HTMLElement | null>(null)
const selectedId = ref('')
const hoverId = ref('')
const hoverCategory = ref('')
const selectedCategories = ref<string[]>([])
const skillDescriptions = ref(new Map<string, string>())
const hoverTipId = ref('')
const hoverPoint = ref({ x: 24, y: 80 })
const graphSize = ref({ width: 1, height: 1 })
const playing = ref(false)
const playbackIndex = ref(-1)
const detailDrawerOpen = ref(false)

let playbackTimer: number | null = null
let clearSelectionTimer: number | null = null
let hoverTipTimer: number | null = null
let pendingHoverTipId = ''
let keyboardPreviewIndex = -1
let disposed = false
let loadGeneration = 0
let skillDescriptionLoadGeneration = 0
let skillDescriptionLoadState: SkillDescriptionLoadState = 'idle'
let skillDescriptionLoadPromise: Promise<void> | null = null

const nodes = computed(() => data.value?.graph.nodes || [])
const edges = computed(() => data.value?.graph.edges || [])
const nodeById = computed(() => new Map(nodes.value.map(node => [node.id, node])))
const selectedNode = computed(() => nodeById.value.get(selectedId.value) || null)
const playbackNodes = computed(() =>
  nodes.value
    .map((node, index) => ({ node, index }))
    .sort((a, b) => {
      const aTime = a.node.timestamp
      const bTime = b.node.timestamp
      if (aTime && bTime && aTime !== bTime) return aTime - bTime
      if (aTime && !bTime) return -1
      if (!aTime && bTime) return 1
      return a.index - b.index
    })
    .map(item => item.node),
)
const revealedNodeIds = computed(() => {
  if (playbackIndex.value < 0) return null
  return new Set(playbackNodes.value.slice(0, playbackIndex.value + 1).map(node => node.id))
})
const visibleNodes = computed(() => {
  const revealed = revealedNodeIds.value
  if (!revealed) return nodes.value
  return nodes.value.filter(node => revealed.has(node.id))
})
const visibleNodeIds = computed(() => new Set(visibleNodes.value.map(node => node.id)))
const visibleEdges = computed(() =>
  edges.value.filter(edge => visibleNodeIds.value.has(edge.source) && visibleNodeIds.value.has(edge.target)),
)
const selectedCategorySet = computed(() => new Set(selectedCategories.value))
const emphasizedCategorySet = computed(() => {
  const categories = new Set(selectedCategories.value)
  if (hoverCategory.value) categories.add(hoverCategory.value)
  return categories
})
const focusNodeId = computed(() => selectedId.value || hoverId.value)
const focusedNeighborIds = computed(() =>
  focusNodeId.value ? journeyNeighborIds(focusNodeId.value, visibleEdges.value) : new Set<string>(),
)
const categoryStats = computed(() => {
  const stats = new Map<string, { category: string; label: string; color: string; count: number }>()
  for (const node of visibleNodes.value) {
    const category = node.category || 'general'
    const current = stats.get(category)
    if (current) {
      current.count += 1
    } else {
      stats.set(category, {
        category,
        label: node.category || t('journey.noCategory'),
        color: categoryColor(category),
        count: 1,
      })
    }
  }
  return [...stats.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
})
const visibleNodeCount = computed(() => Math.max(1, visibleNodes.value.length))
const hoverTipNode = computed(() => hoverTipId.value ? nodeById.value.get(hoverTipId.value) || null : null)
const hoverTipTitle = computed(() => hoverTipNode.value?.label || hoverTipNode.value?.id || '')
const hoverTipDescription = computed(() => {
  const node = hoverTipNode.value
  if (!node) return ''
  if (isMemoryNode(node)) return skillDescriptionPreview(memoryText(node))
  return skillDescriptionPreview(skillDescription(node))
})
const selectedSkillDescription = computed(() => {
  const node = selectedNode.value
  return node && !isMemoryNode(node) ? skillDescription(node) : ''
})
const graphAriaLabel = computed(() =>
  `${t('journey.title')}. ${visibleNodes.value.length} ${t('journey.nodes')}. ${t('journey.canvasInstructions')}`,
)
const hoverTipStyle = computed(() => {
  const tooltipWidth = 320
  const gap = 14
  const x = hoverPoint.value.x + gap + tooltipWidth <= graphSize.value.width
    ? hoverPoint.value.x + gap
    : Math.max(8, hoverPoint.value.x - tooltipWidth - gap)
  const above = hoverPoint.value.y > graphSize.value.height - 150
  return {
    left: `${x}px`,
    top: `${Math.max(8, hoverPoint.value.y + (above ? -gap : gap))}px`,
    transform: above ? 'translateY(-100%)' : undefined,
  }
})

const flowNodes = computed(() => {
  const maxRows = Math.max(3, Math.min(8, Math.floor((graphSize.value.height - 72) / 112)))
  const layout = layoutJourneyGraph(visibleNodes.value, visibleEdges.value, { maxRows })
  const hasNodeFocus = Boolean(focusNodeId.value)
  const hasCategoryFocus = emphasizedCategorySet.value.size > 0

  return layout.map((layoutNode) => {
    const node = nodeById.value.get(layoutNode.id)!
    const category = node.category || 'general'
    const active = focusNodeId.value === node.id
    const related = focusedNeighborIds.value.has(node.id)
    const categoryActive = emphasizedCategorySet.value.has(category)
    const dimmed = hasNodeFocus
      ? !active && !related
      : hasCategoryFocus && !categoryActive

    return {
      id: node.id,
      type: 'journey',
      position: layoutNode.position,
      draggable: false,
      selectable: false,
      connectable: false,
      focusable: false,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      style: {
        width: '240px',
        pointerEvents: 'all' as const,
        zIndex: active ? 4 : related ? 3 : 1,
      },
      data: {
        node,
        column: layoutNode.column,
        degree: layoutNode.degree,
        color: categoryColor(category),
        categoryLabel: node.category || t('journey.noCategory'),
        timestampLabel: formatTime(node.timestamp),
        kindLabel: isMemoryNode(node) ? t('journey.memories') : t('journey.skills'),
        active,
        related,
        dimmed,
      } satisfies JourneyFlowNodeData,
    }
  })
})

const flowEdges = computed(() => {
  const focusId = focusNodeId.value
  const categories = emphasizedCategorySet.value
  return visibleEdges.value.map((edge, index) => {
    const source = nodeById.value.get(edge.source)
    const target = nodeById.value.get(edge.target)
    const active = Boolean(focusId && (edge.source === focusId || edge.target === focusId))
    const categoryActive = Boolean(
      categories.size
      && (
        categories.has(source?.category || 'general')
        || categories.has(target?.category || 'general')
      )
    )
    const stroke = active
      ? categoryColor(target?.category || source?.category || 'general')
      : 'var(--text-muted)'
    return {
      id: `journey-edge:${edge.source}:${edge.target}:${index}`,
      source: edge.source,
      target: edge.target,
      type: 'smoothstep',
      selectable: false,
      focusable: false,
      animated: playing.value && active,
      interactionWidth: 0,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: stroke,
        width: active ? 18 : 14,
        height: active ? 18 : 14,
      },
      style: {
        stroke,
        strokeWidth: active ? 2.4 : categoryActive ? 1.7 : 1.15,
        opacity: active ? 0.95 : categoryActive ? 0.58 : focusId ? 0.08 : 0.24,
      },
      zIndex: active ? 3 : 0,
    }
  })
})

function hash(value: string): number {
  let h = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function categoryColor(category: string): string {
  const categories = [...new Set(nodes.value.map(node => node.category || 'general'))].sort()
  const index = categories.indexOf(category)
  if (index >= 0) return CATEGORY_PALETTE[index % CATEGORY_PALETTE.length]
  return CATEGORY_PALETTE[hash(category) % CATEGORY_PALETTE.length]
}

function formatTime(value?: number | null): string {
  if (!value) return '-'
  return new Date(value * 1000).toLocaleString()
}

function isMemoryNode(node: JourneyNode | null): boolean {
  return node?.kind === 'memory'
}

function detailTitle(node: JourneyNode): string {
  if (isMemoryNode(node)) return node.label || node.category || t('journey.memories')
  return node.label || node.id
}

function memoryIndex(node: JourneyNode): number | null {
  const index = Number(node.id.split(':').pop())
  return Number.isInteger(index) && index >= 0 ? index : null
}

function memoryRecord(node: JourneyNode | null): JourneyMemory | null {
  if (!node || !isMemoryNode(node)) return null
  const memories = data.value?.graph.memory || []
  const index = memoryIndex(node)
  if (index !== null) {
    const match = memories[index]
    if (match && (!node.memorySource || !match.source || match.source === node.memorySource)) return match
  }
  return memories.find(memory =>
    (!node.memorySource || !memory.source || memory.source === node.memorySource)
    && (!node.timestamp || !memory.timestamp || memory.timestamp === node.timestamp),
  ) || null
}

function memoryText(node: JourneyNode): string {
  const memory = memoryRecord(node)
  return memory?.body || memory?.title || node.label || ''
}

function skillDescriptionIdentityKey(category: string, name: string): string {
  return `category:${category}\u0000${name}`
}

function skillDescriptionNameKey(name: string): string {
  return `name:${name}`
}

function skillDescription(node: JourneyNode): string {
  const category = node.category || 'general'
  const idName = node.id.replace(/^skill:/, '')
  return normalizeSkillDescription(
    skillDescriptions.value.get(skillDescriptionIdentityKey(category, node.label))
    || skillDescriptions.value.get(skillDescriptionIdentityKey(category, idName))
    || skillDescriptions.value.get(skillDescriptionNameKey(node.label))
    || skillDescriptions.value.get(skillDescriptionNameKey(idName))
    || '',
  )
}

function skillDescriptionMap(skills: SkillsData): Map<string, string> {
  const descriptions = new Map<string, string>()
  const names = new Map<string, { count: number; description: string }>()
  const addName = (name: string, description: string) => {
    const current = names.get(name)
    names.set(name, {
      count: (current?.count || 0) + 1,
      description: current?.description || description,
    })
  }

  for (const category of skills.categories || []) {
    for (const skill of category.skills || []) {
      descriptions.set(skillDescriptionIdentityKey(category.name, skill.name), skill.description || '')
      addName(skill.name, skill.description || '')
    }
  }
  for (const skill of skills.archived || []) addName(skill.name, skill.description || '')
  for (const [name, entry] of names) {
    if (entry.count === 1) descriptions.set(skillDescriptionNameKey(name), entry.description)
  }
  return descriptions
}

function resetSkillDescriptionLoad(generation: number) {
  skillDescriptions.value = new Map()
  skillDescriptionLoadGeneration = generation
  skillDescriptionLoadState = 'idle'
  skillDescriptionLoadPromise = null
}

function ensureSkillDescriptionsLoaded(generation = loadGeneration): Promise<void> | undefined {
  if (disposed || generation !== loadGeneration) return undefined
  if (skillDescriptionLoadGeneration !== generation) resetSkillDescriptionLoad(generation)
  if (skillDescriptionLoadState === 'loaded' || skillDescriptionLoadState === 'failed') return skillDescriptionLoadPromise || undefined
  if (skillDescriptionLoadState === 'loading') return skillDescriptionLoadPromise || undefined

  skillDescriptionLoadState = 'loading'
  const completion = fetchSkills()
    .then((skills) => {
      if (disposed || generation !== loadGeneration || generation !== skillDescriptionLoadGeneration) return
      skillDescriptions.value = skillDescriptionMap(skills)
      skillDescriptionLoadState = 'loaded'
    })
    .catch(() => {
      if (disposed || generation !== loadGeneration || generation !== skillDescriptionLoadGeneration) return
      skillDescriptionLoadState = 'failed'
    })
  skillDescriptionLoadPromise = completion
  void completion.finally(() => {
    if (generation === skillDescriptionLoadGeneration && skillDescriptionLoadPromise === completion) {
      skillDescriptionLoadPromise = null
    }
  })
  return completion
}

function requestSkillDescription(node: JourneyNode) {
  if (!isMemoryNode(node)) void ensureSkillDescriptionsLoaded()
}

function clearHoverTipTimer() {
  if (hoverTipTimer !== null) window.clearTimeout(hoverTipTimer)
  hoverTipTimer = null
  pendingHoverTipId = ''
}

function hideNodeHoverTip(clearHover = false) {
  clearHoverTipTimer()
  hoverTipId.value = ''
  if (clearHover) hoverId.value = ''
}

function eventPoint(event: MouseEvent): { x: number; y: number } {
  const rect = graphWrapRef.value?.getBoundingClientRect()
  return {
    x: event.clientX - (rect?.left || 0),
    y: event.clientY - (rect?.top || 0),
  }
}

function scheduleNodeHover(node: JourneyNode, point: { x: number; y: number }) {
  hoverPoint.value = point
  hoverId.value = node.id
  if (hoverTipId.value === node.id || pendingHoverTipId === node.id) return
  clearHoverTipTimer()
  hoverTipId.value = ''
  pendingHoverTipId = node.id
  hoverTipTimer = window.setTimeout(() => {
    hoverTipTimer = null
    pendingHoverTipId = ''
    if (!disposed && hoverId.value === node.id) {
      hoverTipId.value = node.id
      requestSkillDescription(node)
    }
  }, 250)
}

function handleNodeMouseEnter(event: MouseEvent, node: JourneyNode) {
  scheduleNodeHover(node, eventPoint(event))
}

function handleNodeMouseMove(event: MouseEvent, node: JourneyNode) {
  if (hoverId.value !== node.id) {
    scheduleNodeHover(node, eventPoint(event))
    return
  }
  hoverPoint.value = eventPoint(event)
}

function handleNodeMouseLeave(nodeId: string) {
  if (hoverId.value === nodeId) hideNodeHoverTip(true)
}

function toggleCategorySelection(category: string) {
  const isSelected = selectedCategorySet.value.has(category)
  selectedCategories.value = isSelected
    ? selectedCategories.value.filter(value => value !== category)
    : [...selectedCategories.value, category]
}

function openNodeDetails(nodeId: string) {
  const node = nodeById.value.get(nodeId)
  if (!node) return
  requestSkillDescription(node)
  selectedId.value = nodeId
  detailDrawerOpen.value = true
}

function clearGraphSelection() {
  selectedId.value = ''
  selectedCategories.value = []
  detailDrawerOpen.value = false
  hideNodeHoverTip(true)
}

function resetInteractionState() {
  stopPlayback()
  clearSelectionDelay()
  keyboardPreviewIndex = -1
  selectedId.value = ''
  hoverId.value = ''
  hoverCategory.value = ''
  selectedCategories.value = []
  hideNodeHoverTip()
  playbackIndex.value = -1
  detailDrawerOpen.value = false
}

function previewNodeFromKeyboard(delta: number, absoluteIndex?: number) {
  const orderedNodes = playbackNodes.value.filter(node => visibleNodeIds.value.has(node.id))
  if (!orderedNodes.length) return
  const currentIndex = orderedNodes.findIndex(node => node.id === hoverTipId.value)
  let baseIndex = currentIndex
  if (baseIndex < 0) baseIndex = keyboardPreviewIndex >= 0 ? keyboardPreviewIndex : delta > 0 ? -1 : 0
  keyboardPreviewIndex = absoluteIndex === undefined
    ? (baseIndex + delta + orderedNodes.length) % orderedNodes.length
    : Math.max(0, Math.min(orderedNodes.length - 1, absoluteIndex))
  const node = orderedNodes[keyboardPreviewIndex]
  clearHoverTipTimer()
  hoverId.value = node.id
  hoverTipId.value = node.id
  hoverPoint.value = {
    x: Math.min(Math.max(24, graphSize.value.width / 2), graphSize.value.width - 24),
    y: 76,
  }
  requestSkillDescription(node)
}

function handleGraphKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    event.preventDefault()
    previewNodeFromKeyboard(1)
    return
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    event.preventDefault()
    previewNodeFromKeyboard(-1)
    return
  }
  if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault()
    const count = playbackNodes.value.filter(node => visibleNodeIds.value.has(node.id)).length
    previewNodeFromKeyboard(0, event.key === 'Home' ? 0 : count - 1)
    return
  }
  if (event.key === 'Enter' || event.key === ' ') {
    if (!hoverTipId.value) previewNodeFromKeyboard(1)
    if (hoverTipId.value) openNodeDetails(hoverTipId.value)
    event.preventDefault()
  }
}

function handleJourneyKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  resetInteractionState()
  event.preventDefault()
}

function clearPlaybackTimer() {
  if (!playbackTimer) return
  window.clearTimeout(playbackTimer)
  playbackTimer = null
}

function clearSelectionDelay() {
  if (!clearSelectionTimer) return
  window.clearTimeout(clearSelectionTimer)
  clearSelectionTimer = null
}

function stopPlayback() {
  clearPlaybackTimer()
  playing.value = false
}

function playNode(index: number) {
  const node = playbackNodes.value[index]
  if (!node) {
    stopPlayback()
    return
  }
  playbackIndex.value = index
  selectedId.value = node.id
  hoverId.value = ''
}

function scheduleNextNode() {
  clearPlaybackTimer()
  playbackTimer = window.setTimeout(() => {
    const nextIndex = playbackIndex.value + 1
    if (nextIndex >= playbackNodes.value.length) {
      stopPlayback()
      clearSelectionDelay()
      clearSelectionTimer = window.setTimeout(() => {
        selectedId.value = ''
        hoverId.value = ''
        clearSelectionTimer = null
      }, 1000)
      return
    }
    playNode(nextIndex)
    scheduleNextNode()
  }, 150)
}

function togglePlayback() {
  if (playing.value) {
    stopPlayback()
    return
  }
  if (!playbackNodes.value.length) return
  clearSelectionDelay()
  playing.value = true
  playNode(0)
  scheduleNextNode()
}

function updateViewportMetrics() {
  const rect = graphWrapRef.value?.getBoundingClientRect()
  if (rect) graphSize.value = { width: rect.width, height: rect.height }
}

async function fitJourneyView() {
  await nextTick()
  if (disposed || !flowNodes.value.length) return
  try {
    await fitView({
      padding: 0.16,
      minZoom: 0.3,
      maxZoom: 1,
      duration: 220,
    })
  } catch {
    // Vue Flow may be gone when a profile switches during unmount.
  }
}

async function loadJourney(options: { clearData?: boolean; resetInteraction?: boolean; fitAfterLoad?: boolean } = {}) {
  const generation = ++loadGeneration
  stopPlayback()
  clearSelectionDelay()
  resetSkillDescriptionLoad(generation)
  if (options.resetInteraction) resetInteractionState()
  if (options.clearData) data.value = null
  loading.value = true
  try {
    const nextData = await fetchJourneyGraph()
    if (disposed || generation !== loadGeneration) return generation
    data.value = nextData
    if (options.fitAfterLoad) void fitJourneyView()
  } catch (err: any) {
    if (disposed || generation !== loadGeneration) return generation
    message.error(err?.message || t('journey.loadFailed'))
  } finally {
    if (!disposed && generation === loadGeneration) loading.value = false
  }
  return generation
}

async function refreshJourney() {
  const generation = await loadJourney()
  if (disposed || generation !== loadGeneration) return
  const descriptionNodeIds = new Set<string>()
  if (detailDrawerOpen.value && selectedId.value) descriptionNodeIds.add(selectedId.value)
  if (hoverTipId.value) descriptionNodeIds.add(hoverTipId.value)
  const needsSkillDescriptions = [...descriptionNodeIds].some((nodeId) => {
    const node = nodeById.value.get(nodeId)
    return node && !isMemoryNode(node)
  })
  if (needsSkillDescriptions) await ensureSkillDescriptionsLoaded(generation)
}

function miniMapNodeColor(node: { data?: JourneyFlowNodeData }): string {
  return node.data?.color || '#7f8c9a'
}

onMounted(() => {
  window.addEventListener('keydown', handleJourneyKeydown)
  window.addEventListener('resize', updateViewportMetrics)
  updateViewportMetrics()
  void loadJourney({ fitAfterLoad: true })
})

onBeforeUnmount(() => {
  disposed = true
  loadGeneration += 1
  window.removeEventListener('keydown', handleJourneyKeydown)
  window.removeEventListener('resize', updateViewportMetrics)
  clearPlaybackTimer()
  clearSelectionDelay()
  clearHoverTipTimer()
})

watch(
  () => profilesStore.activeProfileName || 'default',
  (profile, previousProfile) => {
    if (profile === previousProfile) return
    void loadJourney({ clearData: true, resetInteraction: true, fitAfterLoad: true })
  },
)

watch(nodes, () => {
  if (selectedId.value && !nodeById.value.has(selectedId.value)) {
    selectedId.value = ''
    detailDrawerOpen.value = false
  }
  if (hoverTipId.value && !nodeById.value.has(hoverTipId.value)) hideNodeHoverTip(true)
  const availableCategories = new Set(nodes.value.map(node => node.category || 'general'))
  selectedCategories.value = selectedCategories.value.filter(category => availableCategories.has(category))
})
</script>

<template>
  <PageLoading :show="loading && !data" class="journey-view">
    <PageHeader>
    <header class="page-header journey-view__header">
      <h2 class="header-title">{{ t('journey.title') }}</h2>
    </header>
    </PageHeader>

    <div class="journey-view__content">
      <div class="journey-panel">
        <div class="journey-toolbar">
          <div class="node-kind-legend" :aria-label="t('journey.nodeKinds')">
            <span class="node-kind-legend__item">
              <i class="node-kind-marker node-kind-marker--memory" aria-hidden="true" />
              {{ t('journey.memories') }}
            </span>
            <span class="node-kind-legend__arrow" aria-hidden="true">→</span>
            <span class="node-kind-legend__item">
              <i class="node-kind-marker node-kind-marker--skill" aria-hidden="true" />
              {{ t('journey.skills') }}
            </span>
          </div>
          <NButton
            size="small"
            :disabled="!nodes.length"
            :aria-label="playing ? t('journey.pause') : t('journey.play')"
            :title="playing ? t('journey.pause') : t('journey.play')"
            @click="togglePlayback"
          >
            <span class="playback-icon" :class="{ playing }" aria-hidden="true" />
          </NButton>
          <NButton size="small" :loading="loading" @click="refreshJourney">{{ t('journey.refresh') }}</NButton>
        </div>

        <div v-if="categoryStats.length" class="category-meter">
          <div class="category-bar" role="group" :aria-label="t('journey.categorySelection')">
            <button
              v-for="stat in categoryStats"
              :key="stat.category"
              type="button"
              class="category-bar-segment"
              :class="{
                active: emphasizedCategorySet.has(stat.category),
                selected: selectedCategorySet.has(stat.category),
              }"
              :style="{ '--category-color': stat.color, flexGrow: stat.count }"
              :data-category="stat.category"
              :aria-label="`${stat.label} ${stat.count} / ${Math.round((stat.count / visibleNodeCount) * 100)}%`"
              :aria-pressed="selectedCategorySet.has(stat.category)"
              @mouseenter="hoverCategory = stat.category"
              @mouseleave="hoverCategory = ''"
              @click="toggleCategorySelection(stat.category)"
            />
          </div>
          <div class="category-legend" role="group" :aria-label="t('journey.categorySelection')">
            <button
              v-for="stat in categoryStats"
              :key="stat.category"
              type="button"
              :class="{
                active: emphasizedCategorySet.has(stat.category),
                selected: selectedCategorySet.has(stat.category),
              }"
              :data-category="stat.category"
              :aria-pressed="selectedCategorySet.has(stat.category)"
              @mouseenter="hoverCategory = stat.category"
              @mouseleave="hoverCategory = ''"
              @click="toggleCategorySelection(stat.category)"
            >
              <i :style="{ backgroundColor: stat.color }" />
              {{ stat.label }} · {{ stat.count }}
            </button>
          </div>
        </div>

        <div class="journey-spin">
          <main class="journey-graph-layout">
            <section
              ref="graphWrapRef"
              class="journey-graph-wrap"
              tabindex="0"
              role="group"
              :aria-label="graphAriaLabel"
              @keydown="handleGraphKeydown"
            >
              <VueFlow
                id="hermes-journey"
                :nodes="flowNodes"
                :edges="flowEdges"
                :fit-view-on-init="false"
                :default-viewport="{ x: 32, y: 48, zoom: 0.84 }"
                :min-zoom="0.25"
                :max-zoom="1.4"
                :nodes-draggable="false"
                :nodes-connectable="false"
                :elements-selectable="false"
                :zoom-on-double-click="false"
                class="journey-flow"
                @pane-click="clearGraphSelection"
              >
                <template #node-journey="{ data: nodeData }">
                  <button
                    type="button"
                    class="journey-node"
                    :class="[
                      `journey-node--${nodeData.column}`,
                      {
                        'is-active': nodeData.active,
                        'is-related': nodeData.related,
                        'is-dimmed': nodeData.dimmed,
                      },
                    ]"
                    :style="{ '--node-color': nodeData.color }"
                    @click.stop="openNodeDetails(nodeData.node.id)"
                    @mouseenter="handleNodeMouseEnter($event, nodeData.node)"
                    @mousemove="handleNodeMouseMove($event, nodeData.node)"
                    @mouseleave="handleNodeMouseLeave(nodeData.node.id)"
                  >
                    <Handle type="target" :position="Position.Left" class="journey-node__handle" />
                    <Handle type="source" :position="Position.Right" class="journey-node__handle" />

                    <span class="journey-node__topline">
                      <span class="journey-node__kind">
                        <i aria-hidden="true" />
                        {{ nodeData.kindLabel }}
                      </span>
                      <span class="journey-node__category">{{ nodeData.categoryLabel }}</span>
                    </span>
                    <strong class="journey-node__title">{{ nodeData.node.label || nodeData.node.id }}</strong>
                    <span class="journey-node__meta">
                      <span v-if="nodeData.timestampLabel !== '-'">{{ nodeData.timestampLabel }}</span>
                      <span v-if="nodeData.column === 'skill'">
                        {{ t('journey.useCount') }} {{ nodeData.node.useCount ?? 0 }}
                      </span>
                      <span>{{ nodeData.degree }} {{ t('journey.edges') }}</span>
                    </span>
                  </button>
                </template>

                <Background :gap="24" :size="1.15" color="var(--border-color)" />
                <MiniMap pannable zoomable :node-color="miniMapNodeColor" />
                <Controls :show-interactive="false" />
              </VueFlow>

              <Transition name="journey-tooltip">
                <div
                  v-if="hoverTipNode"
                  class="journey-node-tooltip"
                  role="tooltip"
                  :style="hoverTipStyle"
                >
                  <div class="journey-node-tooltip__name">{{ hoverTipTitle }}</div>
                  <div v-if="hoverTipDescription" class="journey-node-tooltip__description">
                    {{ hoverTipDescription }}
                  </div>
                </div>
              </Transition>

              <div v-if="!loading && !visibleNodes.length" class="journey-empty">
                {{ t('journey.noNodes') }}
              </div>

              <div class="journey-hud">
                <span>{{ data?.profile || '-' }}</span>
                <span>{{ visibleNodes.length }} {{ t('journey.nodes') }}</span>
                <span>{{ visibleEdges.length }} {{ t('journey.edges') }}</span>
              </div>
            </section>
          </main>
        </div>

        <NDrawer v-model:show="detailDrawerOpen" width="var(--studio-drawer-width)" placement="right">
          <NDrawerContent v-if="selectedNode" class="journey-detail-drawer" :native-scrollbar="false" closable>
            <template #header>
              <div class="drawer-title-row">
                <span>{{ detailTitle(selectedNode) }}</span>
                <NTag size="small" :type="selectedNode.kind === 'memory' ? 'info' : 'success'" :bordered="false">
                  {{ selectedNode.kind }}
                </NTag>
              </div>
            </template>

            <div v-if="isMemoryNode(selectedNode) && memoryText(selectedNode)" class="memory-card">
              <span class="detail-card-label">{{ t('journey.memories') }}</span>
              <p>{{ memoryText(selectedNode) }}</p>
            </div>

            <div v-if="selectedSkillDescription" class="memory-card">
              <span class="detail-card-label">{{ t('journey.description') }}</span>
              <p>{{ selectedSkillDescription }}</p>
            </div>

            <div class="detail-card">
              <span class="detail-card-label">ID</span>
              <code>{{ selectedNode.id }}</code>
            </div>

            <div class="detail-grid">
              <div class="detail-item">
                <span>{{ t('journey.category') }}</span>
                <strong>{{ selectedNode.category || '-' }}</strong>
              </div>
              <div class="detail-item">
                <span>{{ t('journey.useCount') }}</span>
                <strong>{{ selectedNode.useCount ?? 0 }}</strong>
              </div>
              <div class="detail-item">
                <span>{{ t('journey.createdBy') }}</span>
                <strong>{{ selectedNode.createdBy || '-' }}</strong>
              </div>
              <div class="detail-item">
                <span>{{ t('journey.timestamp') }}</span>
                <strong>{{ formatTime(selectedNode.timestamp) }}</strong>
              </div>
            </div>

            <NTag v-if="selectedNode.pinned" size="small" type="warning" :bordered="false">{{ t('journey.pinned') }}</NTag>
          </NDrawerContent>
        </NDrawer>
      </div>
    </div>
  </PageLoading>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.journey-view {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.journey-view__header {
  flex: 0 0 auto;
}

.journey-view__content {
  flex: 1;
  min-height: 0;
  padding: 16px 20px 20px;
}

.journey-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.journey-toolbar {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  padding-bottom: 10px;
}

.node-kind-legend {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  margin-inline-end: auto;
  color: $text-secondary;
  font-size: 12px;
}

.node-kind-legend__item {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  white-space: nowrap;
}

.node-kind-legend__arrow {
  color: $text-muted;
  font-size: 15px;
}

:global([dir='rtl']) .node-kind-legend__arrow {
  transform: scaleX(-1);
}

.node-kind-marker {
  width: 10px;
  height: 10px;
  display: inline-block;
  flex: 0 0 auto;
  border: 2px solid currentcolor;
  background: $bg-primary;
  color: #4f8cff;
}

.node-kind-marker--memory {
  border-radius: 2px;
  color: #6ba3d6;
  transform: rotate(45deg);
}

.node-kind-marker--skill {
  border-radius: 50%;
}

.playback-icon {
  width: 0;
  height: 0;
  display: inline-block;
  border-top: 6px solid transparent;
  border-bottom: 6px solid transparent;
  border-inline-start: 10px solid currentcolor;

  &.playing {
    width: 10px;
    height: 12px;
    border: 0;
    background:
      linear-gradient(currentcolor, currentcolor) left center / 3px 12px no-repeat,
      linear-gradient(currentcolor, currentcolor) right center / 3px 12px no-repeat;
  }
}

.category-meter {
  display: grid;
  gap: 7px;
  margin-bottom: 10px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, $border-color 70%, transparent);
  border-radius: $radius-sm;
  background: color-mix(in srgb, $bg-secondary 72%, transparent);
}

.category-bar {
  position: relative;
  display: flex;
  height: 10px;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, $border-color 42%, transparent);

  button {
    position: relative;
    min-width: 10px;
    align-self: stretch;
    padding: 0;
    border: 0;
    background: var(--category-color);
    cursor: pointer;
    opacity: 0.62;
    transition: opacity 0.16s ease, filter 0.16s ease;

    &.active,
    &.selected {
      opacity: 1;
      filter: saturate(1.15);
    }

    &.selected {
      box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.86);
    }

    &:focus-visible {
      z-index: 1;
      outline: 2px solid $text-primary;
      outline-offset: -2px;
    }
  }
}

.category-legend {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  color: $text-secondary;
  font-size: 11px;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }

  button {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex: 0 0 auto;
    padding: 4px 8px;
    border: 1px solid transparent;
    border-radius: 999px;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;

    &.active,
    &.selected {
      border-color: rgba(var(--accent-info-rgb), 0.36);
      background: rgba(var(--accent-info-rgb), 0.09);
      color: $text-primary;
    }

    &.selected {
      border-color: rgba(var(--accent-info-rgb), 0.7);
      font-weight: 600;
    }

    &:focus-visible {
      outline: 2px solid $accent-primary;
      outline-offset: 1px;
    }
  }

  i {
    width: 7px;
    height: 7px;
    flex: 0 0 auto;
    border-radius: 999px;
  }
}

.journey-spin {
  flex: 1;
  height: 100%;
  min-height: 0;
}

.journey-graph-layout,
.journey-graph-wrap,
.journey-flow {
  width: 100%;
  height: 100%;
  min-height: 0;
}

.journey-graph-wrap {
  position: relative;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, $border-color 72%, transparent);
  border-radius: $radius-md;
  background:
    radial-gradient(circle at 50% 45%, rgba(var(--accent-info-rgb), 0.07), transparent 48%),
    $bg-primary;

  &:focus-visible {
    outline: 2px solid $accent-primary;
    outline-offset: -2px;
  }
}

.journey-flow {
  :deep(.vue-flow__pane) {
    cursor: grab;
  }

  :deep(.vue-flow__pane.dragging) {
    cursor: grabbing;
  }

  :deep(.vue-flow__node) {
    border: 0;
    background: transparent;
  }

  :deep(.vue-flow__edge-path) {
    transition: stroke 0.16s ease, stroke-width 0.16s ease, opacity 0.16s ease;
  }

  :deep(.vue-flow__controls) {
    overflow: hidden;
    border: 1px solid color-mix(in srgb, $border-color 78%, transparent);
    border-radius: $radius-sm;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  }

  :deep(.vue-flow__controls-button) {
    border-color: color-mix(in srgb, $border-color 68%, transparent);
    background: color-mix(in srgb, $bg-primary 94%, transparent);
    color: $text-primary;
  }

  :deep(.vue-flow__minimap) {
    width: 138px;
    height: 92px;
    overflow: hidden;
    border: 1px solid color-mix(in srgb, $border-color 72%, transparent);
    border-radius: $radius-sm;
    background: color-mix(in srgb, $bg-primary 90%, transparent);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  }
}

.journey-node {
  position: relative;
  width: 240px;
  min-height: 82px;
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--node-color) 35%, $border-color);
  border-radius: $radius-sm;
  background: color-mix(in srgb, $bg-primary 96%, var(--node-color) 4%);
  box-shadow: 0 7px 20px rgba(0, 0, 0, 0.08);
  color: $text-primary;
  font: inherit;
  text-align: start;
  cursor: pointer;
  transition:
    border-color 0.16s ease,
    box-shadow 0.16s ease,
    opacity 0.16s ease,
    transform 0.16s ease;

  &:hover,
  &:focus-visible,
  &.is-active {
    border-color: var(--node-color);
    box-shadow:
      0 0 0 2px color-mix(in srgb, var(--node-color) 18%, transparent),
      0 11px 28px rgba(0, 0, 0, 0.14);
    transform: translateY(-1px);
  }

  &:focus-visible {
    outline: 2px solid $text-primary;
    outline-offset: 2px;
  }

  &.is-related {
    border-color: color-mix(in srgb, var(--node-color) 72%, $border-color);
    box-shadow: 0 9px 24px rgba(0, 0, 0, 0.12);
  }

  &.is-dimmed {
    opacity: 0.28;
  }
}

.journey-node__handle {
  width: 7px;
  height: 7px;
  border: 2px solid $bg-primary;
  background: var(--node-color);
  opacity: 0.72;
  pointer-events: none;
}

.journey-node__topline,
.journey-node__meta {
  min-width: 0;
  display: flex;
  align-items: center;
}

.journey-node__topline {
  justify-content: space-between;
  gap: 8px;
  color: $text-muted;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.journey-node__kind {
  display: inline-flex;
  align-items: center;
  gap: 6px;

  i {
    width: 7px;
    height: 7px;
    flex: 0 0 auto;
    border-radius: 50%;
    background: var(--node-color);
  }
}

.journey-node--memory .journey-node__kind i {
  border-radius: 1px;
  transform: rotate(45deg);
}

.journey-node__category {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.journey-node__title {
  display: -webkit-box;
  overflow: hidden;
  font-size: 12px;
  font-weight: 650;
  line-height: 1.38;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.journey-node__meta {
  gap: 5px 10px;
  flex-wrap: wrap;
  color: $text-secondary;
  font-size: 10px;
}

.journey-node-tooltip {
  position: absolute;
  z-index: 10;
  width: max-content;
  max-width: min(320px, calc(100% - 16px));
  padding: 9px 11px;
  border: 1px solid color-mix(in srgb, $border-color 82%, transparent);
  border-radius: $radius-sm;
  background: color-mix(in srgb, $bg-primary 96%, transparent);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.2);
  color: $text-primary;
  pointer-events: none;
  backdrop-filter: blur(12px);
}

.journey-node-tooltip__name {
  max-width: 100%;
  overflow: hidden;
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.journey-node-tooltip__description {
  display: -webkit-box;
  margin-top: 4px;
  overflow: hidden;
  color: $text-secondary;
  font-size: 12px;
  line-height: 1.4;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.journey-tooltip-enter-active,
.journey-tooltip-leave-active {
  transition: opacity 0.12s ease;
}

.journey-tooltip-enter-from,
.journey-tooltip-leave-to {
  opacity: 0;
}

.journey-hud {
  position: absolute;
  z-index: 6;
  left: 50%;
  bottom: 14px;
  display: flex;
  gap: 7px;
  color: $text-secondary;
  font-size: 11px;
  pointer-events: none;
  transform: translateX(-50%);

  span {
    padding: 4px 8px;
    border: 1px solid color-mix(in srgb, $border-color 70%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, $bg-primary 88%, transparent);
    backdrop-filter: blur(10px);
  }
}

.journey-empty {
  position: absolute;
  z-index: 5;
  top: 50%;
  left: 50%;
  color: $text-secondary;
  transform: translate(-50%, -50%);
}

.drawer-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;

  span:first-child {
    min-width: 0;
    flex: 1;
    overflow-wrap: anywhere;
  }
}

.journey-detail-drawer {
  :deep(.n-drawer-body-content-wrapper) {
    display: grid;
    align-content: start;
    gap: 14px;
  }
}

.detail-card {
  display: grid;
  gap: 6px;
  padding: 12px;
  border: 1px solid $border-light;
  border-radius: $radius-sm;
  background: rgba(var(--accent-primary-rgb), 0.04);

  code {
    color: $text-primary;
    font-size: 12px;
    line-height: 1.5;
    white-space: normal;
    overflow-wrap: anywhere;
  }
}

.memory-card {
  display: grid;
  gap: 8px;
  padding: 14px;
  border: 1px solid color-mix(in srgb, $border-color 82%, transparent);
  border-radius: $radius-sm;
  background:
    linear-gradient(180deg, rgba(var(--accent-info-rgb), 0.08), transparent),
    $bg-secondary;

  p {
    margin: 0;
    color: $text-primary;
    font-size: 13px;
    line-height: 1.65;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
}

.detail-card-label,
.detail-item span {
  color: $text-secondary;
  font-size: 12px;
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.detail-item {
  min-width: 0;
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid $border-light;
  border-radius: $radius-sm;
  background: $bg-secondary;

  strong {
    min-width: 0;
    color: $text-primary;
    font-size: 13px;
    overflow-wrap: anywhere;
  }
}

@media (max-width: $breakpoint-mobile) {
  .journey-view__content {
    padding: 10px;
  }

  .journey-toolbar {
    flex-wrap: wrap;
  }

  .node-kind-legend {
    width: 100%;
  }

  .category-meter {
    padding: 8px 10px;
  }

  .journey-flow {
    :deep(.vue-flow__minimap) {
      width: 104px;
      height: 70px;
    }
  }

  .journey-hud {
    display: none;
  }

  .detail-grid {
    grid-template-columns: 1fr;
  }
}
</style>
