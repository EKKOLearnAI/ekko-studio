<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { NButton, NCard, NInput, NModal, NSelect, NSwitch, NTabPane, NTabs, useDialog, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { desktopBridge, type DesktopBrowserDownload, type DesktopBrowserProfile, type DesktopBrowserState } from '@/utils/desktop-bridge'

const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()
const bridge = desktopBridge()?.browser
const state = ref<DesktopBrowserState | null>(null)
const settingsProfileId = ref('')
const profileDraft = ref<DesktopBrowserProfile | null>(null)
const profileName = ref('')
const profileRootPath = ref('')
const profileProxyMode = ref<'direct' | 'system' | 'fixed_servers'>('system')
const profileProxyRules = ref('')
const profileModalMode = ref<'create' | 'edit'>('create')
const showProfileModal = ref(false)
const busy = ref(false)
const loadError = ref('')
let stopStateListener: (() => void) | undefined
let unmounting = false

const profileOptions = computed(() => state.value?.profiles.map(profile => ({ label: profile.name, value: profile.id })) || [])
const conflictOptions = computed(() => [
  { label: t('browser.uniquifyDownloads'), value: 'uniquify' },
  { label: t('browser.askOnConflict'), value: 'ask' },
])
const proxyOptions = computed(() => [
  { label: t('browser.proxyDirect'), value: 'direct' },
  { label: t('browser.proxySystem'), value: 'system' },
  { label: t('browser.proxyCustom'), value: 'fixed_servers' },
])
const profileDownloads = computed(() => state.value?.downloads.filter(item => item.profileId === settingsProfileId.value) || [])
const profilePermissions = computed(() => state.value?.permissions.filter(item => item.profileId === settingsProfileId.value) || [])

watch(settingsProfileId, profileId => {
  const profile = state.value?.profiles.find(item => item.id === profileId)
  profileDraft.value = profile ? { ...profile, tabs: [...profile.tabs] } : null
})

function applyState(next: DesktopBrowserState): void {
  state.value = next
  if (!settingsProfileId.value || !next.profiles.some(profile => profile.id === settingsProfileId.value)) {
    settingsProfileId.value = next.activeProfileId
  }
}

function openCreateProfile(): void {
  profileModalMode.value = 'create'
  profileName.value = ''
  profileRootPath.value = ''
  profileProxyMode.value = 'system'
  profileProxyRules.value = ''
  profileDraft.value = null
  showProfileModal.value = true
}

function openEditProfile(profile: DesktopBrowserProfile): void {
  profileModalMode.value = 'edit'
  settingsProfileId.value = profile.id
  profileDraft.value = { ...profile, tabs: [...profile.tabs] }
  showProfileModal.value = true
}

function closeProfileModal(): void {
  showProfileModal.value = false
}

async function run(action: () => Promise<unknown>): Promise<void> {
  busy.value = true
  try {
    await action()
  } catch (error) {
    if (!unmounting) message.error(error instanceof Error ? error.message : String(error))
  } finally {
    busy.value = false
  }
}

async function switchProfile(profileId: string): Promise<void> {
  if (!bridge || profileId === state.value?.activeProfileId) return
  try {
    const impact = await bridge.profileSwitchImpact()
    if (!impact.requiresConfirmation) return run(() => bridge.switchProfile(profileId))
    dialog.warning({
      title: t('browser.profileSwitchTitle'),
      content: t('browser.profileSwitchWarning', { agents: impact.activeAgentRuns, downloads: impact.activeDownloads, annotations: impact.pendingAnnotations }),
      positiveText: t('common.confirm'),
      negativeText: t('common.cancel'),
      onPositiveClick: () => run(() => bridge.switchProfile(profileId, true)),
    })
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  }
}

function createProfile(): void {
  const name = profileName.value.trim()
  const rootDirectory = profileRootPath.value.trim()
  if (!name || !rootDirectory) return
  void run(async () => {
    const created = await bridge!.createProfile({
      name,
      rootDirectory,
      proxyMode: profileProxyMode.value,
      proxyRules: profileProxyRules.value.trim(),
    })
    profileName.value = ''
    profileRootPath.value = ''
    settingsProfileId.value = created.id
    profileDraft.value = { ...created, tabs: [...created.tabs] }
    showProfileModal.value = false
  })
}

function chooseProfileRootDirectory(target: 'create' | 'edit' = 'create'): void {
  void run(async () => {
    const currentPath = target === 'edit' ? profileDraft.value?.rootPath : profileRootPath.value
    const selected = await bridge!.chooseProfileRootDirectory(currentPath || undefined)
    if (!selected) return
    if (target === 'edit' && profileDraft.value) {
      profileDraft.value.rootPath = selected
      profileDraft.value.sessionPath = profilePath(selected, 'data')
      profileDraft.value.downloadPath = profilePath(selected, 'download')
    } else {
      profileRootPath.value = selected
    }
  })
}

function profilePath(rootValue: string, name: 'data' | 'download'): string {
  const root = rootValue.trim()
  if (!root) return name
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  return `${root.replace(/[\\/]+$/, '')}${separator}${name}`
}

function profileChildPath(name: 'data' | 'download'): string {
  return profilePath(profileRootPath.value, name)
}

function saveProfile(): void {
  const draft = profileDraft.value
  if (!draft) return
  void run(async () => {
    const renamed = await bridge!.renameProfile(draft.id, draft.name)
    const updated = await bridge!.updateProfile(draft.id, {
      rootDirectory: draft.rootPath,
      proxyMode: draft.proxyMode,
      proxyRules: draft.proxyRules,
      askBeforeDownload: draft.askBeforeDownload,
      downloadConflictPolicy: draft.downloadConflictPolicy,
    })
    profileDraft.value = { ...updated, name: renamed.name, tabs: [...updated.tabs] }
    showProfileModal.value = false
    message.success(t('common.saved'))
  })
}

function deleteProfile(profileId: string): void {
  dialog.warning({
    title: t('browser.deleteProfileTitle'),
    content: t('browser.deleteProfileWarning'),
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => run(() => bridge!.deleteProfile(profileId)),
  })
}

function clearProfileData(kind: 'cache' | 'site-data' | 'permission-audit'): void {
  const profileId = settingsProfileId.value
  if (!profileId) return
  const clear = () => run(async () => {
    await bridge!.clearProfileData(profileId, kind)
    message.success(t('browser.dataCleared'))
  })
  if (kind !== 'site-data') {
    void clear()
    return
  }
  dialog.warning({
    title: t('browser.clearSiteData'),
    content: t('browser.clearSiteDataWarning'),
    positiveText: t('common.confirm'),
    negativeText: t('common.cancel'),
    onPositiveClick: clear,
  })
}

function cancelDownload(downloadId: string): void {
  void run(async () => applyState(await bridge!.cancelDownload(downloadId)))
}

function formatBytes(input: number): string {
  const bytes = Number.isFinite(input) ? Math.max(0, input) : 0
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = units[0]
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024
    unit = units[index]
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`
}

function downloadPercent(item: DesktopBrowserDownload): number | null {
  if (item.totalBytes <= 0) return null
  return Math.min(100, Math.max(0, Math.round(item.receivedBytes / item.totalBytes * 100)))
}

function downloadStateLabel(stateValue: DesktopBrowserDownload['state']): string {
  return t(`browser.downloadState${stateValue[0].toUpperCase()}${stateValue.slice(1)}`)
}

function downloadSummary(item: DesktopBrowserDownload): string {
  const percent = downloadPercent(item)
  const transferred = item.totalBytes > 0
    ? `${formatBytes(item.receivedBytes)} / ${formatBytes(item.totalBytes)}`
    : formatBytes(item.receivedBytes)
  return `${downloadStateLabel(item.state)}${percent === null ? '' : ` · ${percent}%`} · ${transferred}`
}

onMounted(async () => {
  if (!bridge) return
  try {
    const next = await bridge.getState()
    applyState(next)
    stopStateListener = bridge.onStateChange(applyState)
  } catch (error) {
    loadError.value = `${t('browser.loadFailed')}: ${error instanceof Error ? error.message : String(error)}`
    message.error(loadError.value)
  }
})

onUnmounted(() => {
  unmounting = true
  stopStateListener?.()
})
</script>

<template>
  <section class="browser-settings-page">
    <div v-if="!bridge" class="unavailable">{{ t('browser.desktopOnly') }}</div>
    <template v-else>
      <header class="page-header">
        <h2 class="header-title">{{ t('browser.title') }}</h2>
        <div class="header-actions">
          <NButton type="primary" size="small" :disabled="busy" @click="openCreateProfile">
            <template #icon>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </template>
            {{ t('browser.addProfile') }}
          </NButton>
        </div>
      </header>

      <div v-if="loadError" class="unavailable">{{ loadError }}</div>
      <NCard v-else class="settings-card" :bordered="false">
        <NTabs type="line" animated>
          <NTabPane name="profiles" :tab="t('browser.profiles')">
            <div v-if="state" class="profiles-grid">
              <article
                v-for="profile in state.profiles"
                :key="profile.id"
                class="profile-card"
                :class="{ active: profile.id === state.activeProfileId }"
              >
                <div class="profile-card-header">
                  <h3 :title="profile.name">{{ profile.name }}</h3>
                  <span v-if="profile.id === state.activeProfileId" class="active-badge">{{ t('browser.currentProfile') }}</span>
                </div>
                <div class="profile-card-body">
                  <div class="profile-info-row">
                    <span>{{ t('browser.profileRootDirectory') }}</span>
                    <code :title="profile.rootPath">{{ profile.rootPath }}</code>
                  </div>
                  <div class="profile-preferences">
                    <span>{{ t('browser.proxy') }} · {{ profile.proxyMode === 'fixed_servers' ? profile.proxyRules : profile.proxyMode === 'system' ? t('browser.proxySystem') : t('browser.proxyDirect') }}</span>
                    <span>{{ t('browser.askBeforeDownload') }} · {{ profile.askBeforeDownload ? t('common.enable') : t('common.disable') }}</span>
                    <span>{{ profile.downloadConflictPolicy === 'ask' ? t('browser.askOnConflict') : t('browser.uniquifyDownloads') }}</span>
                  </div>
                </div>
                <div class="profile-card-actions">
                  <NButton
                    size="tiny"
                    quaternary
                    :disabled="busy || profile.id === state.activeProfileId"
                    @click="switchProfile(profile.id)"
                  >
                    {{ profile.id === state.activeProfileId ? t('browser.currentProfile') : t('browser.switchProfile') }}
                  </NButton>
                  <NButton size="tiny" quaternary :disabled="busy" @click="openEditProfile(profile)">{{ t('common.edit') }}</NButton>
                  <NButton
                    v-if="state.profiles.length > 1 && profile.id !== state.activeProfileId"
                    size="tiny"
                    quaternary
                    type="error"
                    :disabled="busy"
                    @click="deleteProfile(profile.id)"
                  >
                    {{ t('common.delete') }}
                  </NButton>
                </div>
              </article>
            </div>
          </NTabPane>

          <NTabPane name="downloads" :tab="t('browser.downloads')">
            <label class="profile-filter">{{ t('browser.profiles') }}<NSelect v-model:value="settingsProfileId" :options="profileOptions" /></label>
            <div v-if="!profileDownloads.length" class="empty">{{ t('common.noData') }}</div>
            <article v-for="item in profileDownloads" :key="item.id" class="record download-record">
              <div class="download-record-heading">
                <strong>{{ item.fileName }}</strong>
                <NButton v-if="item.state === 'progressing'" size="tiny" type="error" ghost @click="cancelDownload(item.id)">{{ t('common.cancel') }}</NButton>
              </div>
              <progress v-if="item.state === 'progressing' && item.totalBytes > 0" :value="item.receivedBytes" :max="item.totalBytes" />
              <progress v-else-if="item.state === 'progressing'" />
              <span>{{ downloadSummary(item) }}</span>
              <span v-if="item.savePath">{{ item.savePath }}</span>
            </article>
          </NTabPane>

          <NTabPane name="permissions" :tab="t('browser.permissions')">
            <label class="profile-filter">{{ t('browser.profiles') }}<NSelect v-model:value="settingsProfileId" :options="profileOptions" /></label>
            <p class="hint permissions-hint">{{ t('browser.permissionsHint') }}</p>
            <div class="form-actions">
              <NButton @click="clearProfileData('cache')">{{ t('browser.clearCache') }}</NButton>
              <NButton @click="clearProfileData('permission-audit')">{{ t('browser.clearPermissionAudit') }}</NButton>
              <NButton type="error" ghost @click="clearProfileData('site-data')">{{ t('browser.clearSiteData') }}</NButton>
            </div>
            <div v-if="!profilePermissions.length" class="empty">{{ t('common.noData') }}</div>
            <div v-for="item in profilePermissions" :key="item.id" class="record"><strong>{{ item.origin }}</strong><span>{{ item.permission }} · {{ t('browser.blocked') }}</span></div>
          </NTabPane>
        </NTabs>
      </NCard>

      <NModal
        v-model:show="showProfileModal"
        preset="card"
        :title="profileModalMode === 'create' ? t('browser.addProfile') : t('browser.editProfile')"
        :style="{ width: 'min(620px, calc(100vw - 32px))' }"
        :mask-closable="!busy"
        :close-on-esc="!busy"
      >
        <div v-if="profileModalMode === 'create'" class="settings-form profile-editor-form">
          <label>
            {{ t('browser.profileName') }}
            <NInput v-model:value="profileName" :placeholder="t('browser.profileName')" autofocus @keydown.enter="createProfile" />
          </label>
          <label>
            {{ t('browser.profileRootDirectory') }}
            <div class="path-row">
              <NInput v-model:value="profileRootPath" readonly :placeholder="t('browser.chooseProfileRootDirectory')" />
              <NButton data-testid="choose-browser-profile-root" :disabled="busy" @click="chooseProfileRootDirectory()">…</NButton>
            </div>
          </label>
          <p class="hint">{{ t('browser.profileRootDirectoryHint', { data: profileChildPath('data'), download: profileChildPath('download') }) }}</p>
          <label>{{ t('browser.proxyMode') }}<NSelect v-model:value="profileProxyMode" :options="proxyOptions" /></label>
          <label v-if="profileProxyMode === 'fixed_servers'">{{ t('browser.proxyServer') }}<NInput v-model:value="profileProxyRules" :placeholder="t('browser.proxyServerPlaceholder')" /></label>
        </div>
        <div v-else-if="profileDraft" class="settings-form profile-editor-form">
          <label>{{ t('browser.profileName') }}<NInput v-model:value="profileDraft.name" /></label>
          <label>{{ t('browser.profileRootDirectory') }}<div class="path-row"><NInput v-model:value="profileDraft.rootPath" readonly /><NButton :disabled="busy" @click="chooseProfileRootDirectory('edit')">…</NButton></div></label>
          <p class="hint">{{ t('browser.profileRootDirectoryHint', { data: profileDraft.sessionPath, download: profileDraft.downloadPath }) }}</p>
          <label>{{ t('browser.proxyMode') }}<NSelect v-model:value="profileDraft.proxyMode" :options="proxyOptions" /></label>
          <label v-if="profileDraft.proxyMode === 'fixed_servers'">{{ t('browser.proxyServer') }}<NInput v-model:value="profileDraft.proxyRules" :placeholder="t('browser.proxyServerPlaceholder')" /></label>
          <label class="switch-row"><span>{{ t('browser.askBeforeDownload') }}</span><NSwitch v-model:value="profileDraft.askBeforeDownload" /></label>
          <label>{{ t('browser.downloadConflictPolicy') }}<NSelect v-model:value="profileDraft.downloadConflictPolicy" :options="conflictOptions" /></label>
        </div>
        <template #footer>
          <div class="modal-actions">
            <NButton :disabled="busy" @click="closeProfileModal">{{ t('common.cancel') }}</NButton>
            <NButton
              type="primary"
              :loading="busy"
              :disabled="profileModalMode === 'create'
                ? !profileName.trim() || !profileRootPath.trim() || profileProxyMode === 'fixed_servers' && !profileProxyRules.trim()
                : !profileDraft?.name.trim() || profileDraft?.proxyMode === 'fixed_servers' && !profileDraft.proxyRules.trim()"
              @click="profileModalMode === 'create' ? createProfile() : saveProfile()"
            >
              {{ profileModalMode === 'create' ? t('common.create') : t('common.save') }}
            </NButton>
          </div>
        </template>
      </NModal>
    </template>
  </section>
</template>

<style scoped lang="scss">
.browser-settings-page { height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; color: var(--text-color); }
.settings-card { flex: 1; min-height: 0; overflow: auto; padding: 4px 12px 20px; }
.settings-card :deep(.n-card__content) { max-width: 1120px; width: 100%; margin: 0 auto; }
.profiles-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 420px), 1fr)); gap: 14px; }
.profile-card { min-width: 0; display: flex; flex-direction: column; padding: 16px; border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-card); transition: border-color .16s ease, box-shadow .16s ease; }
.profile-card:hover { border-color: rgba(var(--accent-primary-rgb), .3); }
.profile-card.active { border-color: rgba(var(--accent-primary-rgb), .55); box-shadow: inset 0 0 0 1px rgba(var(--accent-primary-rgb), .1); }
.profile-card-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.profile-card-header h3 { min-width: 0; margin: 0; overflow: hidden; color: var(--text-primary); font-size: 15px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.active-badge { flex: none; padding: 2px 8px; border-radius: 10px; background: rgba(var(--accent-primary-rgb), .12); color: var(--accent-primary); font-size: 11px; font-weight: 500; }
.profile-card-body { flex: 1; display: grid; gap: 12px; }
.profile-info-row { min-width: 0; display: grid; gap: 4px; }
.profile-info-row > span { color: var(--text-muted); font-size: 12px; }
.profile-info-row code { display: block; overflow: hidden; color: var(--text-secondary); font-family: var(--font-code, monospace); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.pending-path { margin: -6px 0 0; color: var(--warning); font-size: 11px; }
.profile-preferences { display: flex; flex-wrap: wrap; gap: 6px; }
.profile-preferences span { padding: 3px 7px; border-radius: 4px; background: rgba(var(--accent-primary-rgb), .08); color: var(--text-secondary); font-size: 11px; }
.profile-card-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--border-light); }
.path-row, .form-actions { display: flex; align-items: center; gap: 8px; }
.path-row .n-input { flex: 1; }
.settings-form { display: grid; gap: 14px; }.settings-form label, .profile-filter { display: grid; gap: 6px; font-size: 13px; }.profile-filter { max-width: 320px; margin-bottom: 16px; }
.profile-editor-form { margin: 0; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
.switch-row { display: flex !important; align-items: center; justify-content: space-between; }
.hint { color: var(--text-color-3); font-size: 12px; }.record { display: grid; gap: 3px; padding: 10px 0; border-bottom: 1px solid var(--border-color); }.record span { color: var(--text-color-3); font-size: 12px; overflow-wrap: anywhere; }.empty, .unavailable { padding: 40px; text-align: center; color: var(--text-color-3); }
.permissions-hint { margin: 0 0 14px; }
.download-record { gap: 7px; }
.download-record-heading { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.download-record-heading strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.download-record progress { width: 100%; height: 6px; accent-color: var(--primary-color, #3b82f6); }
@media (max-width: 640px) { .profiles-grid { grid-template-columns: 1fr; }.form-actions { flex-wrap: wrap; } }
</style>
