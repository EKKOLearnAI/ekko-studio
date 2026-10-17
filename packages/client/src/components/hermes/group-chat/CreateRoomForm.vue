<script setup lang="ts">
import { ref, nextTick, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { NInput, NButton, NSpace, NInputNumber, NSelect } from 'naive-ui'
import { getStoredUsername } from '@/api/client'
import FolderPicker from '@/components/hermes/chat/FolderPicker.vue'
import { useAppStore } from '@/stores/hermes/app'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { canScopedCodingAgentUseProvider } from '@/utils/codingAgentProviders'
import { generateGroupChatInviteCode } from '@/utils/group-chat-invite-code'
import { inferCodingAgentApiMode, normalizeCodingAgentApiMode } from '@/api/coding-agents'
import type { RoomAgentInput, RoomSummaryConfig } from '@/api/studio/group-chat'

type InputLikeInstance = {
    focus: () => void
}

const { t } = useI18n()
const appStore = useAppStore()
const profilesStore = useProfilesStore()
const emit = defineEmits<{
    submit: [name: string, inviteCode: string, userName: string, description: string, summary: RoomSummaryConfig, workspace: string, agents: RoomAgentInput[]]
    cancel: []
}>()

const roomName = ref('')
const inviteCode = ref('')
const workspace = ref('')
const userName = ref(localStorage.getItem('gc_user_name') || getStoredUsername() || '')
const description = ref(localStorage.getItem('gc_user_description') || '')
const roomInput = ref<InputLikeInstance | null>(null)

const summaryProfile = computed(() => profilesStore.activeProfileName || 'default')
const summaryProvider = ref('')
const summaryModel = ref('')
const summaryApiMode = ref('chat_completions')
const summaryEveryTurns = ref(20)

const summaryModelGroups = computed(() =>
    (appStore.profileModelGroups.find(entry => entry.profile === summaryProfile.value)?.groups || [])
        .filter(group => group.provider !== 'moa' && canScopedCodingAgentUseProvider('ekko-agent', group.provider))
)
const summaryProviderOptions = computed(() => summaryModelGroups.value.map(group => ({
    label: group.label || group.provider,
    value: group.provider,
})))
const selectedSummaryProviderGroup = computed(() =>
    summaryModelGroups.value.find(group => group.provider === summaryProvider.value)
)
const summaryModelOptions = computed(() =>
    (selectedSummaryProviderGroup.value?.models || []).map(model => ({
        label: appStore.displayModelName(model, summaryProvider.value),
        value: model,
    }))
)
const summaryApiModeOptions = computed(() => [
    { label: t('codingAgents.protocolOpenAiChat'), value: 'chat_completions' },
    { label: t('codingAgents.protocolOpenAiResponses'), value: 'codex_responses' },
    { label: t('codingAgents.protocolAnthropicMessages'), value: 'anthropic_messages' },
])
function syncSummaryProvider() {
    const profileModels = appStore.profileModelGroups.find(entry => entry.profile === summaryProfile.value)
    const preferred = summaryModelGroups.value.find(group => group.provider === appStore.selectedProvider)
        || summaryModelGroups.value.find(group => group.provider === profileModels?.default_provider)
        || summaryModelGroups.value[0]
    summaryProvider.value = preferred?.provider || ''
    summaryModel.value = preferred?.models.includes(profileModels?.default || '')
        ? profileModels?.default || ''
        : preferred?.models[0] || ''
    summaryApiMode.value = normalizeCodingAgentApiMode(
        preferred?.api_mode,
        inferCodingAgentApiMode(preferred?.provider || '', preferred?.base_url),
    )
}

function handleSummaryProviderChange(provider: string) {
    summaryProvider.value = provider
    summaryModel.value = summaryModelOptions.value[0]?.value || ''
    const group = selectedSummaryProviderGroup.value
    summaryApiMode.value = normalizeCodingAgentApiMode(
        group?.api_mode,
        inferCodingAgentApiMode(group?.provider || provider, group?.base_url),
    )
}

watch([summaryModelGroups, summaryProfile], () => {
    if (!summaryModelGroups.value.some(group => group.provider === summaryProvider.value)) syncSummaryProvider()
}, { immediate: true })

function handleCreate() {
    const name = roomName.value.trim()
    const code = inviteCode.value.trim() || generateGroupChatInviteCode()
    const user = userName.value.trim()
    if (!name || !user) return
    emit('submit', name, code, user, description.value.trim(), {
        summaryProfile: summaryProfile.value,
        summaryProvider: summaryProvider.value,
        summaryModel: summaryModel.value,
        summaryApiMode: summaryApiMode.value,
        summaryEveryTurns: summaryEveryTurns.value,
    }, workspace.value || '', [])
}

function focusRoomInput() {
    nextTick(() => roomInput.value?.focus())
}

onMounted(() => {
    void Promise.all([
        profilesStore.fetchProfiles(),
        appStore.loadModels(),
    ])
})
</script>

<template>
    <div class="create-form">
        <div class="form-group">
            <label class="form-label">{{ t('groupChat.yourName') }}</label>
            <NInput
                v-model:value="userName"
                :placeholder="t('groupChat.yourNamePlaceholder')"
                :maxlength="120"
                @keyup.enter="focusRoomInput"
            />
        </div>
        <div class="form-group">
            <label class="form-label">{{ t('groupChat.yourDescription') }}</label>
            <NInput
                v-model:value="description"
                type="textarea"
                :rows="2"
                :maxlength="2000"
                :placeholder="t('groupChat.yourDescriptionPlaceholder')"
            />
        </div>
        <div class="form-group">
            <label class="form-label">{{ t('groupChat.roomName') }}</label>
            <NInput
                ref="roomInput"
                v-model:value="roomName"
                :placeholder="t('groupChat.roomNamePlaceholder')"
                @keyup.enter="handleCreate"
            />
        </div>
        <div class="form-group">
            <label class="form-label">{{ t('groupChat.inviteCode') }}</label>
            <div class="code-row">
                <NInput
                    v-model:value="inviteCode"
                    :placeholder="t('groupChat.autoGenerate')"
                />
                <NButton size="small" @click="inviteCode = generateGroupChatInviteCode()">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                    </svg>
                </NButton>
            </div>
        </div>

        <div class="form-group">
            <label class="form-label">{{ t('chat.workspace') }}</label>
            <FolderPicker v-model="workspace" />
        </div>

        <section class="summary-section">
            <h4>{{ t('groupChat.summarySettings') }}</h4>
            <p class="form-hint summary-hint">{{ t('groupChat.summarySettingsDesc') }}</p>
            <div class="form-group">
                <label class="form-label">{{ t('groupChat.summaryProvider') }}</label>
                <NSelect
                    :value="summaryProvider"
                    :options="summaryProviderOptions"
                    :placeholder="t('groupChat.summaryProviderPlaceholder')"
                    @update:value="handleSummaryProviderChange"
                />
            </div>
            <div class="form-group">
                <label class="form-label">{{ t('groupChat.summaryModel') }}</label>
                <NSelect
                    v-model:value="summaryModel"
                    :options="summaryModelOptions"
                    :disabled="!summaryProvider"
                    :placeholder="t('groupChat.summaryModelPlaceholder')"
                />
            </div>
            <div class="form-group">
                <label class="form-label">{{ t('groupChat.summaryApiMode') }}</label>
                <NSelect v-model:value="summaryApiMode" :options="summaryApiModeOptions" />
            </div>
            <div class="form-group">
                <label class="form-label">{{ t('groupChat.summaryEveryTurns') }}</label>
                <NInputNumber v-model:value="summaryEveryTurns" :min="1" :max="1000" :step="1" style="width: 100%" />
                <p class="form-hint">{{ t('groupChat.summaryEveryTurnsDesc') }}</p>
            </div>
        </section>

        <div class="modal-actions">
            <NSpace justify="end">
                <NButton @click="emit('cancel')">{{ t('common.cancel') }}</NButton>
                <NButton type="primary" :disabled="!roomName.trim() || !userName.trim() || !summaryProvider || !summaryModel || !summaryApiMode" @click="handleCreate">{{ t('common.create') }}</NButton>
            </NSpace>
        </div>
    </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.create-form {
    .form-group {
        margin-bottom: 16px;
    }
}

.form-label {
    display: block;
    font-size: calc(var(--font-size-base, 14px) * 13 / 14);
    font-weight: 500;
    color: $text-secondary;
    margin-bottom: 6px;
}

.form-hint {
    font-size: calc(var(--font-size-base, 14px) * 11 / 14);
    color: $text-muted;
    margin: 4px 0 0;
}

.code-row {
    display: flex;
    gap: calc(8px * var(--spacing-scale, 1));
    align-items: center;
}

.summary-section {
    padding: calc(14px * var(--spacing-scale, 1));
    margin-bottom: 16px;
    border: var(--border-width, 1px) solid $border-color;
    border-radius: var(--radius-component, 10px);

    h4 {
        margin: 0;
        font-size: calc(var(--font-size-base, 14px) * 14 / 14);
    }
}

.summary-hint {
    margin: 4px 0 14px;
}

</style>
