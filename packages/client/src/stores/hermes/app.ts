import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  fetchAvailableModels,
  addCustomModel as persistCustomModel,
  removeCustomModel as deletePersistedCustomModel,
  updateDefaultModel,
  updateModelVisibility,
  updateModelAlias,
  type AvailableModelGroup,
  type AvailableModelsResponse,
  type ProfileAvailableModels,
  type ModelVisibility,
  type ModelVisibilityRule,
} from '@/api/hermes/system'
import { checkHealth, triggerUpdate, clearStaleUpdateStatus as clearStaleUpdateStatusRequest, fetchUpdateIdentity, repairUpdateIdentity as repairUpdateIdentityRequest, fetchUpdateCapabilities, fetchUpdateStatus, fetchUpdateEnvironment, reconcileUpdate as reconcileUpdateRequest, type UpdateIdentityResponse, type EnvironmentCheckResponse, type UpdateStatusResponse, type UpdateTaskRecord, type UpdateTaskStage, type UpdateTaskStatus, type UpdateCapabilitiesResponse } from '@/api/studio/device-update'
import { clampMessageForUi } from '@/utils/format-text'
import { hasApiKey } from '@/api/client'
import { clampSidebarWidth, SIDEBAR_DEFAULT_WIDTH } from '@/utils/sidebar-width'

const WEB_UI_VERSION = __APP_VERSION__

const SIDEBAR_COLLAPSED_KEY = 'hermes_sidebar_collapsed'
const SIDEBAR_WIDTH_KEY = 'hermes_sidebar_width'
const ACTIVE_PROFILE_STORAGE_KEY = 'hermes_active_profile_name'
const MODELS_CACHE_TTL_MS = 30000
const UPDATE_RELOAD_TIMEOUT_MS = 30 * 60 * 1000
const UPDATE_POLL_INTERVAL_MS = 3000

export const useAppStore = defineStore('app', () => {
  const sidebarOpen = ref(false)
  // Desktop-only collapsed state (icon-rail mode). Persisted to localStorage.
  const sidebarCollapsed = ref(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1')
  const sidebarWidth = ref(SIDEBAR_DEFAULT_WIDTH)
  const sidebarResizing = ref(false)
  try {
    const savedWidth = localStorage.getItem(SIDEBAR_WIDTH_KEY)
    if (savedWidth !== null) sidebarWidth.value = clampSidebarWidth(Number(savedWidth))
  } catch {
    // Keep resizing available when browser storage is unavailable.
  }
  // Expanded state of route-owned sidebars, used by the Windows title bar.
  const pageSidebarExpanded = ref(true)

  const connected = ref(false)
  const serverVersion = ref(WEB_UI_VERSION)
  const latestVersion = ref('')
  const updateEnabled = ref(false)
  const updateAvailable = ref(false)
  const updateSourceLabel = ref('')
  const updateChannel = ref('')
  const updateStrategy = ref('')
  const updatePackageType = ref('')
  const environmentCheck = ref<EnvironmentCheckResponse | null>(null)
  const environmentDismissed = ref(false)
  // Phase (a) identity drift (docs/harness/source-deploy-refactor.md).
  const updateIdentity = ref<UpdateIdentityResponse | null>(null)
  const identityDismissed = ref(false)
  const identityRepairing = ref(false)
  const clientOutdated = ref(false)
  const updating = ref(false)
  const updateTaskId = ref('')
  const updateTaskStatus = ref<UpdateTaskStatus>('idle')
  const updateTaskStage = ref<UpdateTaskStage>('idle')
  const updateTaskMessage = ref('')
  const updateTaskWarning = ref('')
  const updateTaskError = ref('')
  const updateRiskLevel = ref<'low' | 'medium' | 'high'>('low')
  const updateBlockingText = ref('')
  const updateCapabilitiesWarning = ref('')
  const updateCapabilitiesRemoteError = ref('')
  const updateAutoInstallDependencies = ref(true)
  const updateRollbackSupported = ref(false)
  const updateChecksumVerification = ref(false)
  const updateStateFile = ref('')
  const updateLogDir = ref('')
  const updateStagingDir = ref('')
  const updateBackupDir = ref('')
  const modelGroups = ref<AvailableModelGroup[]>([])
  const profileModelGroups = ref<ProfileAvailableModels[]>([])
  const selectedModel = ref('')
  const selectedProvider = ref('')
  const customModels = ref<Record<string, string[]>>({})
  const modelAliases = ref<Record<string, Record<string, string>>>({})
  const modelVisibility = ref<ModelVisibility>({})
  const healthPollTimer = ref<ReturnType<typeof setInterval>>()
  const nodeVersion = ref('')
  const isDocker = ref(false)

  // Settings
  const streamEnabled = ref(true)
  const sessionPersistence = ref(true)
  const maxTokens = ref(4096)
  let modelsLoadPromise: Promise<void> | null = null
  let modelsLastRequestedAt = 0

  let updatePollPromise: Promise<void> | null = null

  function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  function resetUpdateTaskState() {
    updateTaskId.value = ''
    updateTaskStatus.value = 'idle'
    updateTaskStage.value = 'idle'
    updateTaskMessage.value = ''
    updateTaskWarning.value = ''
    updateTaskError.value = ''
  }

  function applyUpdateTask(task: UpdateTaskRecord | null) {
    if (!task) {
      if (!updating.value) resetUpdateTaskState()
      return
    }
    updateTaskId.value = task.id
    updateTaskStatus.value = task.status
    updateTaskStage.value = task.stage
    updateTaskMessage.value = clampMessageForUi(task.message)
    updateTaskWarning.value = task.warning || ''
    updateTaskError.value = clampMessageForUi(task.error)
    updating.value = task.status === 'queued' || task.status === 'running'
  }

  function getPreferredTask(status: UpdateStatusResponse): UpdateTaskRecord | null {
    // If the running version matches the latest published version, discard
    // historical failed tasks so the red error banner does not stay stuck
    // after a successful upgrade. When webui_latest has not yet been probed
    // (first launch), fall through to currentTask/lastTask as a safety net.
    const versionUpToDate =
      typeof status.webui_latest === 'string'
      && status.webui_latest !== ''
      && typeof status.webui_version === 'string'
      && status.webui_version !== ''
      && status.webui_latest === status.webui_version

    if (versionUpToDate) {
      return null
    }

    return status.currentTask || status.lastTask
  }

  async function checkUpdateStatus() {
    try {
      const res = await fetchUpdateStatus()
      const task = getPreferredTask(res)
      applyUpdateTask(task)
      return task
    } catch {
      return null
    }
  }

  async function refreshEnvironmentCheck() {
    try {
      const res = await fetchUpdateEnvironment()
      environmentCheck.value = res
      if (res.status === 'ok') environmentDismissed.value = false
    } catch {
      environmentCheck.value = null
    }
  }

  function dismissEnvironmentDrift() {
    environmentDismissed.value = true
  }

  // Identity drift: identity.json claims a different version than the
  // running server reports via /health. Health OK -> repairable (red
  // banner with a Repair button that only re-stamps identity).
  const identityDrift = computed(() => {
    const identity = updateIdentity.value
    if (!identity?.installed || !identity.identity) return false
    return !!serverVersion.value && identity.identity.version !== serverVersion.value
  })

  const identityRepairAvailable = computed(() => identityDrift.value && connected.value)

  async function refreshUpdateIdentity(): Promise<void> {
    try {
      updateIdentity.value = await fetchUpdateIdentity()
    } catch {
      updateIdentity.value = null
    }
  }

  async function repairUpdateIdentity(): Promise<boolean> {
    identityRepairing.value = true
    try {
      await repairUpdateIdentityRequest()
      await refreshUpdateIdentity()
      identityDismissed.value = false
      return true
    } catch {
      return false
    } finally {
      identityRepairing.value = false
    }
  }

  async function triggerEnvironmentReconcile(): Promise<boolean> {
    try {
      await reconcileUpdateRequest()
      environmentDismissed.value = false
      return true
    } catch {
      return false
    }
  }

  async function monitorUpdateProgress(timeoutMs = UPDATE_RELOAD_TIMEOUT_MS) {
    if (updatePollPromise) return updatePollPromise

    updatePollPromise = (async () => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        await Promise.all([checkConnection(), checkUpdateStatus()])
        if (clientOutdated.value) {
          reloadClient()
          return
        }
        if (updateTaskStatus.value === 'failed' || updateTaskStatus.value === 'succeeded') {
          updating.value = false
          return
        }
        await sleep(UPDATE_POLL_INTERVAL_MS)
      }

      updating.value = false
      updateTaskStatus.value = 'failed'
      updateTaskStage.value = 'failed'
      updateTaskMessage.value = 'Update status polling timed out'
      updateTaskError.value = 'Update status polling timed out'
    })().finally(() => {
      updatePollPromise = null
    })

    return updatePollPromise
  }

  async function doUpdate(): Promise<boolean> {
    if (updating.value || !updateEnabled.value) return false

    updating.value = true
    try {
      const res = await triggerUpdate()
      updateTaskId.value = res.taskId || ''
      updateTaskStatus.value = res.status || 'queued'
      updateTaskStage.value = res.stage || 'queued'
      updateTaskMessage.value = res.message || ''
      updateTaskWarning.value = res.warning || ''
      updateTaskError.value = ''
      updateAvailable.value = false
      latestVersion.value = ''
      void monitorUpdateProgress()
      return true
    } catch (err) {
      console.error('Failed to update Hermes Web UI:', err)
      updateTaskStatus.value = 'failed'
      updateTaskStage.value = 'failed'
      updateTaskMessage.value = 'Update request failed'
      updateTaskError.value = err instanceof Error ? err.message : String(err)
      updating.value = false
      return false
    }
  }

  async function clearStaleUpdateStatus(): Promise<boolean> {
    try {
      await clearStaleUpdateStatusRequest()
      updating.value = false
      resetUpdateTaskState()
      await checkUpdateStatus()
      return true
    } catch (err) {
      console.error('Failed to clear stale update status:', err)
      return false
    }
  }

  function applyUpdateCapabilities(res: UpdateCapabilitiesResponse) {
    updateRiskLevel.value = res.preflight?.riskLevel || 'low'
    updateBlockingText.value = res.preflight?.blockingText || ''
    updateCapabilitiesWarning.value = res.preflight?.warningText || ''
    updateCapabilitiesRemoteError.value = res.remoteError || ''
    updateAutoInstallDependencies.value = !!res.runtime?.autoInstallDependencies
    updateRollbackSupported.value = !!res.supports?.rollback
    updateChecksumVerification.value = !!res.supports?.checksumVerification
    updateStateFile.value = res.runtime?.stateFile || ''
    updateLogDir.value = res.runtime?.logDir || ''
    updateStagingDir.value = res.runtime?.stagingDir || ''
    updateBackupDir.value = res.runtime?.backupDir || ''
  }

  async function refreshUpdateCapabilities() {
    if (!updateEnabled.value) {
      updateRiskLevel.value = 'low'
      updateBlockingText.value = ''
      updateCapabilitiesWarning.value = ''
      updateCapabilitiesRemoteError.value = ''
      return
    }
    try {
      applyUpdateCapabilities(await fetchUpdateCapabilities())
    } catch (err) {
      updateCapabilitiesRemoteError.value = err instanceof Error ? err.message : String(err)
    }
  }

  async function checkConnection() {
    try {
      const res = await checkHealth()
      connected.value = res.status === 'ok'
      if (res.webui_version) serverVersion.value = res.webui_version
      clientOutdated.value = !!res.webui_version && res.webui_version !== WEB_UI_VERSION
      if (res.webui_latest) latestVersion.value = res.webui_latest
      else latestVersion.value = ''
      updateEnabled.value = !!res.webui_update_enabled
      updateSourceLabel.value = res.webui_update_source_label || ''
      updateChannel.value = res.webui_update_channel || ''
      updateStrategy.value = res.webui_update_strategy || ''
      updatePackageType.value = res.webui_update_package_type || ''
      updateAvailable.value = !!res.webui_update_available
      if (res.node_version) nodeVersion.value = res.node_version
      isDocker.value = !!res.is_docker
      if (res.environment) {
        environmentCheck.value = {
          success: true,
          status: res.environment.status,
          lastCapturedAt: res.environment.capturedAt ?? null,
          manifestVersion: res.environment.manifestVersion ?? null,
          actualVersion: res.environment.actualVersion ?? null,
          nodeVersion: res.environment.nodeVersion ?? null,
          agentVersion: res.environment.agentVersion ?? null,
          drift: res.environment.drift ?? [],
          reconcileSupported: res.environment.reconcileSupported ?? false,
          checkedAt: res.environment.checkedAt ?? null,
        }
        if (res.environment.status === 'ok') environmentDismissed.value = false
      }
      await refreshUpdateCapabilities()
      void refreshUpdateIdentity()
    } catch {
      connected.value = false
      clientOutdated.value = false
      updateEnabled.value = false
      updateAvailable.value = false
      updateSourceLabel.value = ''
      updateChannel.value = ''
      updateStrategy.value = ''
      updatePackageType.value = ''
      updateRiskLevel.value = 'low'
      updateBlockingText.value = ''
      updateCapabilitiesWarning.value = ''
      updateCapabilitiesRemoteError.value = ''
    }
  }

  function applyAvailableModelsResponse(res: AvailableModelsResponse, opts: { preserveSelection?: boolean } = {}) {
    const previousModel = selectedModel.value
    const previousProvider = selectedProvider.value

    modelGroups.value = res.groups
    profileModelGroups.value = res.profiles || []
    modelAliases.value = res.model_aliases || {}
    modelVisibility.value = res.model_visibility || {}
    customModels.value = res.custom_models || {}

    // Manual refresh keeps the user's current selection as long as it still exists
    // in the freshly loaded groups, instead of snapping back to the config default.
    if (opts.preserveSelection && previousModel && previousProvider) {
      const stillAvailable = res.groups.some(
        g => g.provider === previousProvider && g.models.includes(previousModel),
      ) || (res.custom_models?.[previousProvider] || []).includes(previousModel)
      if (stillAvailable) return
    }

    const activeProfileName = localStorage.getItem(ACTIVE_PROFILE_STORAGE_KEY) || ''
    const activeProfileModels = activeProfileName
      ? profileModelGroups.value.find(entry => entry.profile === activeProfileName)
      : undefined
    const defaultSource = activeProfileModels || res
    const defaultGroups = defaultSource.groups || []
    const defaultModel = defaultSource.default || ''
    const defaultProvider = defaultSource.default_provider || ''
    const explicitGroup = defaultGroups.find(g => g.provider === defaultProvider && g.models.includes(defaultModel))
    const inferredGroup = defaultGroups.find(g => g.models.includes(defaultModel))
    const fallbackGroup = defaultGroups.find(g => g.models.length > 0)

    const providerGroup = defaultProvider ? defaultGroups.find(g => g.provider === defaultProvider) : undefined
    const allProvider = defaultProvider ? res.allProviders.find(g => g.provider === defaultProvider) : undefined
    const providerCatalog = providerGroup?.available_models?.length
      ? providerGroup.available_models
      : allProvider?.available_models?.length
        ? allProvider.available_models
        : allProvider?.models || []
    const visibilityRule = defaultProvider ? modelVisibility.value[defaultProvider] : undefined
    const hiddenByVisibility = !!(
      defaultModel &&
      visibilityRule?.mode === 'include' &&
      !visibilityRule.models.includes(defaultModel) &&
      (providerCatalog.length === 0 || providerCatalog.includes(defaultModel))
    )
    const unlistedDefault = !!(
      defaultModel &&
      defaultProvider &&
      providerGroup &&
      !providerGroup.models.includes(defaultModel) &&
      !hiddenByVisibility
    )

    if (explicitGroup || inferredGroup) {
      const selectedGroup = explicitGroup || inferredGroup!
      selectedModel.value = defaultModel
      selectedProvider.value = selectedGroup.provider
    } else if (unlistedDefault) {
      selectedModel.value = defaultModel
      selectedProvider.value = defaultProvider
      customModels.value = {
        ...customModels.value,
        [defaultProvider]: Array.from(new Set([...(customModels.value[defaultProvider] || []), defaultModel])),
      }
    } else if (fallbackGroup) {
      selectedModel.value = fallbackGroup.models[0]
      selectedProvider.value = fallbackGroup.provider
    } else {
      selectedModel.value = ''
      selectedProvider.value = ''
    }
  }

  async function loadModels(force = false, opts: { preserveSelection?: boolean } = {}) {
    if (!hasApiKey()) return
    if (!force && modelsLoadPromise) return modelsLoadPromise
    if (!force && modelsLastRequestedAt > 0 && Date.now() - modelsLastRequestedAt < MODELS_CACHE_TTL_MS) return
    modelsLastRequestedAt = Date.now()
    modelsLoadPromise = (async () => {
      try {
        const res = await fetchAvailableModels()
        applyAvailableModelsResponse(res, opts)
      } catch {
        // ignore
      } finally {
        modelsLoadPromise = null
      }
    })()
    return modelsLoadPromise
  }

  async function waitForModelsForRun(timeoutMs = 15000) {
    if (!hasApiKey()) return
    const pending = modelsLoadPromise || (modelsLastRequestedAt === 0 ? loadModels() : null)
    if (!pending) return
    await Promise.race([
      pending,
      new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
    ])
  }

  async function reloadModels(opts: { preserveSelection?: boolean } = {}) {
    return loadModels(true, opts)
  }

  function getModelAlias(modelId: string, provider?: string): string {
    if (provider) return modelAliases.value[provider]?.[modelId] || ''
    for (const aliases of Object.values(modelAliases.value)) {
      if (aliases[modelId]) return aliases[modelId]
    }
    return ''
  }

  function displayModelName(modelId: string, provider?: string): string {
    return getModelAlias(modelId, provider) || modelId
  }

  function removeModelFromGroupList(groups: AvailableModelGroup[], provider: string, modelId: string): AvailableModelGroup[] {
    return groups.map(group => {
      if (group.provider !== provider) return group
      return {
        ...group,
        models: group.models.filter(model => model !== modelId),
        available_models: group.available_models?.filter(model => model !== modelId),
      }
    })
  }

  function removeModelFromLoadedGroups(provider: string, modelId: string) {
    modelGroups.value = removeModelFromGroupList(modelGroups.value, provider, modelId)
    profileModelGroups.value = profileModelGroups.value.map(profileEntry => ({
      ...profileEntry,
      groups: removeModelFromGroupList(profileEntry.groups, provider, modelId),
    }))
  }

  async function setModelAlias(modelId: string, provider: string, alias: string) {
    const cleanAlias = alias.trim()
    await updateModelAlias({ provider, model: modelId, alias: cleanAlias })
    const next = { ...modelAliases.value }
    const providerAliases = { ...(next[provider] || {}) }
    if (cleanAlias) {
      providerAliases[modelId] = cleanAlias
      next[provider] = providerAliases
    } else {
      delete providerAliases[modelId]
      if (Object.keys(providerAliases).length > 0) next[provider] = providerAliases
      else delete next[provider]
    }
    modelAliases.value = next
  }

  async function switchModel(modelId: string, providerOverride?: string) {
    try {
      // Find the group containing this model to get provider info
      const group = modelGroups.value.find(g => g.models.includes(modelId))
      const provider = providerOverride || group?.provider || ''
      await updateDefaultModel({ default: modelId, provider })
      selectedModel.value = modelId
      selectedProvider.value = provider || ''
      // Track as custom if not already in the server-fetched list
      if (provider && !modelGroups.value.find(g => g.provider === provider)?.models.includes(modelId)) {
        const res = await persistCustomModel({ provider, model: modelId })
        customModels.value = res.custom_models || {}
      }
    } catch (err: any) {
      console.error('Failed to switch model:', err)
    }
  }

  async function removeCustomModel(modelId: string, provider: string) {
    const providerModels = customModels.value[provider] || []
    if (!providerModels.includes(modelId)) return

    const nextCustomModels = { ...customModels.value }
    const remaining = providerModels.filter(m => m !== modelId)
    if (remaining.length > 0) nextCustomModels[provider] = remaining
    else delete nextCustomModels[provider]
    try {
      const res = await deletePersistedCustomModel({ provider, model: modelId })
      customModels.value = res.custom_models || nextCustomModels
    } catch (err) {
      console.error('Failed to remove custom model:', err)
      customModels.value = nextCustomModels
    }
    removeModelFromLoadedGroups(provider, modelId)

    if (selectedModel.value === modelId && selectedProvider.value === provider) {
      const providerGroup = modelGroups.value.find(g => g.provider === provider && g.models.length > 0)
      const fallbackGroup = providerGroup || modelGroups.value.find(g => g.models.length > 0)
      if (fallbackGroup) {
        await switchModel(fallbackGroup.models[0], fallbackGroup.provider)
      } else {
        selectedModel.value = ''
        selectedProvider.value = ''
      }
    }
  }

  function getProviderVisibility(provider: string): ModelVisibilityRule {
    return modelVisibility.value[provider] || { mode: 'all', models: [] }
  }

  function isModelVisible(provider: string, model: string): boolean {
    const rule = getProviderVisibility(provider)
    return rule.mode !== 'include' || rule.models.includes(model)
  }

  async function setModelVisibility(provider: string, rule: ModelVisibilityRule) {
    const res = await updateModelVisibility({ provider, mode: rule.mode, models: rule.models })
    modelVisibility.value = res.model_visibility || {}
    await reloadModels()
  }

  function startHealthPolling(interval = 30000) {
    stopHealthPolling()
    checkConnection()
    healthPollTimer.value = setInterval(checkConnection, interval)
  }

  function stopHealthPolling() {
    if (healthPollTimer.value) {
      clearInterval(healthPollTimer.value)
      healthPollTimer.value = undefined
    }
  }

  function reloadClient() {
    const url = new URL(window.location.href)
    url.searchParams.set('__hwui_reload', Date.now().toString())
    window.location.replace(url.toString())
  }

  function toggleSidebar() {
    sidebarOpen.value = !sidebarOpen.value
  }

  function closeSidebar() {
    sidebarOpen.value = false
  }

  function toggleSidebarCollapsed() {
    sidebarCollapsed.value = !sidebarCollapsed.value
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed.value ? '1' : '0')
    } catch {
      // ignore quota errors — fallback to in-memory only
    }
  }

  function setPageSidebarExpanded(expanded: boolean) {
    pageSidebarExpanded.value = expanded
  }

  function setSidebarWidth(width: number, persist = true) {
    sidebarWidth.value = clampSidebarWidth(width)
    if (!persist) return
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth.value))
    } catch {
      // Keep the in-memory width when browser storage is unavailable.
    }
  }

  return {
    updateEnabled,
    updateSourceLabel,
    updateChannel,
    updateStrategy,
    updatePackageType,
    updateTaskId,
    updateTaskStatus,
    updateTaskStage,
    updateTaskMessage,
    updateTaskWarning,
    updateTaskError,
    updateRiskLevel,
    updateBlockingText,
    updateCapabilitiesWarning,
    updateCapabilitiesRemoteError,
    updateAutoInstallDependencies,
    updateRollbackSupported,
    updateChecksumVerification,
    updateStateFile,
    updateLogDir,
    updateStagingDir,
    updateBackupDir,
    clearStaleUpdateStatus,
    checkUpdateStatus,
    refreshUpdateCapabilities,
    environmentCheck,
    environmentDismissed,
    updateIdentity,
    identityDismissed,
    identityDrift,
    identityRepairAvailable,
    identityRepairing,
    refreshUpdateIdentity,
    repairUpdateIdentity,
    refreshEnvironmentCheck,
    dismissEnvironmentDrift,
    triggerEnvironmentReconcile,

    sidebarOpen,
    sidebarCollapsed,
    sidebarWidth,
    sidebarResizing,
    setSidebarWidth,
    pageSidebarExpanded,
    toggleSidebar,
    closeSidebar,
    toggleSidebarCollapsed,
    setPageSidebarExpanded,
    connected,
    serverVersion,
    latestVersion,
    nodeVersion,
    isDocker,
    updateAvailable,
    clientOutdated,
    updating,
    doUpdate,
    reloadClient,
    modelGroups,
    profileModelGroups,
    customModels,
    modelAliases,
    modelVisibility,
    selectedModel,
    selectedProvider,
    streamEnabled,
    sessionPersistence,
    maxTokens,
    checkConnection,
    loadModels,
    waitForModelsForRun,
    reloadModels,
    applyAvailableModelsResponse,
    switchModel,
    removeCustomModel,
    getModelAlias,
    displayModelName,
    setModelAlias,
    getProviderVisibility,
    isModelVisible,
    setModelVisibility,
    startHealthPolling,
    stopHealthPolling,
  }
})
