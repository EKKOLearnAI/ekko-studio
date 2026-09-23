<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NInput, NModal, useMessage } from 'naive-ui'
import GroupChatPanel from '@/components/hermes/group-chat/GroupChatPanel.vue'
import LanguageSwitch from '@/components/layout/LanguageSwitch.vue'
import ProfileAvatar from '@/components/hermes/profiles/ProfileAvatar.vue'
import { getStoredUserId, type RoomAgent } from '@/api/studio/group-chat'
import type { ProfileAvatar as ProfileAvatarData } from '@/api/hermes/profiles'
import {
    createGuestAgentHandoff,
    getGuestAgentPairingStatus,
    requestGuestAgentPairing,
    type GroupAgentPairingRequest,
    type RemoteGroupAgentDescriptor,
} from '@/api/studio/group-chat-agent-link'
import { GROUP_CHAT_MEMBER_REMOVED, useGroupChatStore } from '@/stores/hermes/group-chat'
import { generateClientUuid } from '@/utils/client-random'
import { copyToClipboard } from '@/utils/clipboard'
import { parseStoredAvatar } from '@/utils/group-agent-avatar'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const store = useGroupChatStore()
const message = useMessage()

const inviteCodeDraft = ref('')
const guestNameDraft = ref(localStorage.getItem('gc_user_name')?.trim() || '')
const guestAvatarFileInput = ref<HTMLInputElement | null>(null)
const guestAvatarError = ref('')
const defaultGuestAvatar = (): ProfileAvatarData => ({
    type: 'generated',
    seed: `guest-${getStoredUserId()}`,
})
const guestAvatarDraft = ref<ProfileAvatarData>(
    parseStoredAvatar(localStorage.getItem('gc_user_avatar')) || defaultGuestAvatar(),
)
const joinedInviteCode = ref('')
const joining = ref(false)
const joinError = ref<'' | 'invite' | 'name-conflict' | 'name-reserved' | 'removed'>('')
const showAgentLinkModal = ref(false)
const targetOriginDraft = ref('http://127.0.0.1:8748')
const agentLinkStage = ref<'idle' | 'selecting' | 'pending' | 'approved' | 'connecting' | 'connected' | 'error'>('idle')
const agentLinkError = ref('')
const pairingCode = ref('')
const selectedTargetOrigin = ref('')
const pairingRequest = ref<GroupAgentPairingRequest | null>(null)
const popupState = ref('')
let targetPopup: Window | null = null
let pairingRequestSecret = ''
let pairingTicket = ''
let pairingPollTimer: ReturnType<typeof setTimeout> | null = null
let joinGeneration = 0

const routeInviteCode = computed(() => {
    const value = route.params.inviteCode
    return typeof value === 'string' ? value.trim() : ''
})
const joined = computed(() => !!joinedInviteCode.value && !!store.currentRoomId)
const collectingGuestName = computed(() => !!routeInviteCode.value && joinError.value !== 'invite')
const currentRoom = computed(() => store.rooms.find(room => room.id === store.currentRoomId) || null)
const guestAgentsAllowed = computed(() => Number(currentRoom.value?.allowGuestAgents || 0) === 1)
const agentLinkStatusText = computed(() => {
    if (agentLinkStage.value === 'pending') return t('groupChat.agentLinkWaitingApproval')
    if (agentLinkStage.value === 'approved' || agentLinkStage.value === 'connecting') {
        return t('groupChat.agentLinkApproved')
    }
    if (agentLinkStage.value === 'connected') return t('groupChat.agentLinkConnected')
    return ''
})

function randomState(): string {
    return generateClientUuid()
}

function randomSecret(): string {
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    let binary = ''
    bytes.forEach(byte => { binary += String.fromCharCode(byte) })
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function randomRequestId(): string {
    return generateClientUuid()
}

function normalizeTargetOrigin(value: string): string {
    let raw = value.trim()
    if (!raw) throw new Error(t('groupChat.agentLinkTargetRequired'))
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `http://${raw}`
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(t('groupChat.agentLinkInvalidTarget'))
    }
    if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
        throw new Error(t('groupChat.agentLinkInvalidTarget'))
    }
    return url.origin
}

function encodePairingCode(agent: RemoteGroupAgentDescriptor): string {
    const json = JSON.stringify({
        protocolVersion: 2,
        cloudOrigin: window.location.origin,
        pairingTicket,
        agent,
    })
    const bytes = new TextEncoder().encode(json)
    let binary = ''
    bytes.forEach(byte => { binary += String.fromCharCode(byte) })
    return `HGC2.${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`
}

function clearPairingPoll(): void {
    if (pairingPollTimer) clearTimeout(pairingPollTimer)
    pairingPollTimer = null
}

function reportPairingFailureToTarget(errorMessage: string): boolean {
    agentLinkStage.value = 'error'
    agentLinkError.value = errorMessage
    if (!targetPopup || targetPopup.closed || !selectedTargetOrigin.value || !popupState.value) return false
    try {
        targetPopup.postMessage({
            type: 'hermes.group-chat.pairing-failed',
            state: popupState.value,
            error: errorMessage,
        }, selectedTargetOrigin.value)
        return true
    } catch {
        return false
    }
}

function pairingErrorMessage(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error || '')
    if (
        raw.includes('ROOM_PARTICIPANT_NAME_CONFLICT')
        || raw.toLowerCase().includes('name is already in use')
    ) {
        return t('groupChat.shareNameConflict')
    }
    return raw || t('groupChat.agentLinkError')
}

function resetAgentLinkAttempt(): void {
    clearPairingPoll()
    pairingRequest.value = null
    pairingRequestSecret = ''
    pairingTicket = ''
    pairingCode.value = ''
    popupState.value = ''
    agentLinkError.value = ''
    agentLinkStage.value = 'idle'
}

function openAgentLinkModal(): void {
    resetAgentLinkAttempt()
    showAgentLinkModal.value = true
}

function openOwnedAgentEditor(agent: RoomAgent): void {
    if (
        agent.executorType !== 'remote'
        || agent.ownerMemberId !== store.userId
        || !agent.connectorId
        || !agent.remoteOrigin
    ) return
    try {
        const origin = normalizeTargetOrigin(agent.remoteOrigin)
        const query = new URLSearchParams({
            parentOrigin: window.location.origin,
            state: randomState(),
            editConnectorId: agent.connectorId,
        })
        const popup = window.open(
            `${origin}/?groupChatAgentLink=1#/group-chat-link?${query}`,
            'hermes-group-chat-agent-link',
            'popup=yes,width=540,height=720',
        )
        if (!popup) {
            message.error(t('groupChat.agentLinkPopupBlocked'))
            return
        }
        targetPopup = popup
    } catch {
        message.error(t('groupChat.agentLinkInvalidTarget'))
    }
}

function openTargetAuthorization(): void {
    if (!guestAgentsAllowed.value) {
        agentLinkError.value = t('groupChat.guestAgentsDisabled')
        agentLinkStage.value = 'error'
        return
    }
    try {
        const origin = normalizeTargetOrigin(targetOriginDraft.value)
        selectedTargetOrigin.value = origin
        targetOriginDraft.value = origin
        popupState.value = randomState()
        const requestId = randomRequestId()
        pairingRequestSecret = randomSecret()
        pairingTicket = randomSecret()
        agentLinkError.value = ''
        agentLinkStage.value = 'selecting'
        const query = new URLSearchParams({
            parentOrigin: window.location.origin,
            state: popupState.value,
            cloudOrigin: window.location.origin,
            inviteCode: joinedInviteCode.value,
            requestId,
            requestSecret: pairingRequestSecret,
            pairingTicket,
        })
        targetPopup = window.open(
            `${origin}/?groupChatAgentLink=1#/group-chat-link?${query}`,
            'hermes-group-chat-agent-link',
            'popup=yes,width=540,height=720',
        )
        if (!targetPopup) {
            agentLinkStage.value = 'error'
            agentLinkError.value = t('groupChat.agentLinkPopupBlocked')
            return
        }
        void createGuestAgentHandoff(joinedInviteCode.value, {
            requestId,
            requestSecret: pairingRequestSecret,
            pairingTicket,
            ownerMemberId: store.userId,
            membershipToken: store.agentLinkToken,
            targetOrigin: origin,
        }).then((result) => {
            pairingRequest.value = result.request
            clearPairingPoll()
            pairingPollTimer = setTimeout(() => void pollPairingStatus(), 300)
        }).catch((handoffError) => {
            const errorMessage = pairingErrorMessage(handoffError)
            agentLinkStage.value = 'error'
            agentLinkError.value = errorMessage
            reportPairingFailureToTarget(errorMessage)
        })
    } catch (error) {
        agentLinkStage.value = 'error'
        agentLinkError.value = error instanceof Error ? error.message : t('groupChat.agentLinkInvalidTarget')
    }
}

async function pollPairingStatus(agent?: RemoteGroupAgentDescriptor): Promise<void> {
    if (!pairingRequest.value || !pairingRequestSecret || !joinedInviteCode.value) return
    try {
        const result = await getGuestAgentPairingStatus(
            joinedInviteCode.value,
            pairingRequest.value.id,
            pairingRequestSecret,
        )
        pairingRequest.value = result.request
        if (result.request.status === 'draft') {
            agentLinkStage.value = 'selecting'
        } else if (result.request.status === 'pending') {
            agentLinkStage.value = 'pending'
        } else if (result.request.status === 'approved') {
            if (agent) pairingCode.value = encodePairingCode(agent)
            agentLinkStage.value = 'approved'
            if (agent && targetPopup && !targetPopup.closed) {
                targetPopup.postMessage({
                    type: 'hermes.group-chat.connect',
                    state: popupState.value,
                    cloudOrigin: window.location.origin,
                    pairingTicket,
                    agent,
                }, selectedTargetOrigin.value)
                agentLinkStage.value = 'connecting'
            } else {
                agentLinkStage.value = 'connecting'
            }
        } else if (result.request.status === 'connecting') {
            if (agent) pairingCode.value = encodePairingCode(agent)
            agentLinkStage.value = 'connecting'
        } else if (result.request.status === 'consumed') {
            agentLinkStage.value = 'connected'
            clearPairingPoll()
            return
        } else if (
            result.request.status === 'rejected'
            || result.request.status === 'expired'
            || result.request.status === 'failed'
        ) {
            const errorMessage = result.request.status === 'rejected'
                ? t('groupChat.agentLinkRejected')
                : result.request.status === 'failed'
                    ? result.request.failureReason || t('groupChat.agentLinkConnectFailed')
                    : t('groupChat.agentLinkExpired')
            if (!reportPairingFailureToTarget(errorMessage)) {
                agentLinkStage.value = 'error'
                agentLinkError.value = errorMessage
            }
            clearPairingPoll()
            return
        }
    } catch (error) {
        const errorMessage = pairingErrorMessage(error)
        if (!reportPairingFailureToTarget(errorMessage)) {
            agentLinkStage.value = 'error'
            agentLinkError.value = errorMessage
        }
        clearPairingPoll()
        return
    }
    pairingPollTimer = setTimeout(() => void pollPairingStatus(agent), 1_200)
}

async function createPairingRequest(agent: RemoteGroupAgentDescriptor): Promise<void> {
    try {
        agentLinkStage.value = 'pending'
        agentLinkError.value = ''
        const result = await requestGuestAgentPairing(joinedInviteCode.value, {
            ownerMemberId: store.userId,
            membershipToken: store.agentLinkToken,
            targetOrigin: selectedTargetOrigin.value,
            agent,
        })
        pairingRequest.value = result.request
        pairingRequestSecret = result.requestSecret
        pairingTicket = result.pairingTicket
        clearPairingPoll()
        pairingPollTimer = setTimeout(() => void pollPairingStatus(agent), 600)
    } catch (error) {
        const errorMessage = pairingErrorMessage(error)
        if (!reportPairingFailureToTarget(errorMessage)) {
            agentLinkStage.value = 'error'
            agentLinkError.value = errorMessage
        }
    }
}

function handleTargetMessage(event: MessageEvent): void {
    if (
        !targetPopup
        || event.source !== targetPopup
        || !popupState.value
    ) return
    if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return
    const data = event.data as Record<string, unknown>
    if (data?.state !== popupState.value) return
    if (data.type === 'hermes.group-chat.link-ready') {
        try {
            const actualOrigin = normalizeTargetOrigin(String(data.targetOrigin || ''))
            if (actualOrigin !== event.origin) return
            selectedTargetOrigin.value = actualOrigin
            targetOriginDraft.value = actualOrigin
            targetPopup.postMessage({
                type: 'hermes.group-chat.parent-ready',
                state: popupState.value,
            }, actualOrigin)
        } catch {
            return
        }
        return
    }
    if (event.origin !== selectedTargetOrigin.value) return
    if (data.type === 'hermes.group-chat.agent-selected') {
        targetPopup.postMessage({
            type: 'hermes.group-chat.selection-received',
            state: popupState.value,
        }, selectedTargetOrigin.value)
        void createPairingRequest(data.agent as RemoteGroupAgentDescriptor)
    } else if (data.type === 'hermes.group-chat.connected') {
        agentLinkStage.value = 'connected'
        clearPairingPoll()
    } else if (data.type === 'hermes.group-chat.connect-failed') {
        agentLinkStage.value = 'error'
        agentLinkError.value = String(data.error || t('groupChat.agentLinkConnectFailed'))
    }
}

async function copyPairingCode(): Promise<void> {
    if (pairingCode.value) await copyToClipboard(pairingCode.value)
}

async function joinInvite(code: string): Promise<void> {
    const normalizedCode = code.trim()
    if (!normalizedCode || joining.value) return

    const generation = ++joinGeneration
    joining.value = true
    joinError.value = ''
    joinedInviteCode.value = ''
    store.disconnect()

    try {
        await store.joinByCode(normalizedCode, { guest: true })
        if (generation !== joinGeneration) return
        joinedInviteCode.value = normalizedCode
    } catch (err: any) {
        if (generation !== joinGeneration) return
        store.disconnect()
        if (err?.code === 'ROOM_PARTICIPANT_NAME_CONFLICT') joinError.value = 'name-conflict'
        else if (err?.code === 'ROOM_PARTICIPANT_NAME_RESERVED') joinError.value = 'name-reserved'
        else joinError.value = 'invite'
    } finally {
        if (generation === joinGeneration) joining.value = false
    }
}

async function submitInvite(): Promise<void> {
    const code = inviteCodeDraft.value.trim()
    if (!code) return
    if (routeInviteCode.value === code) {
        joinError.value = ''
        return
    }
    await router.replace({ name: 'share.groupChat', params: { inviteCode: code } })
}

async function submitGuestName(): Promise<void> {
    const name = guestNameDraft.value.trim()
    if (!name || !routeInviteCode.value) return
    store.setUserInfo(
        name,
        localStorage.getItem('gc_user_description') || '',
        JSON.stringify(guestAvatarDraft.value),
    )
    await joinInvite(routeInviteCode.value)
}

function randomizeGuestAvatar(): void {
    const randomPart = generateClientUuid()
    guestAvatarDraft.value = { type: 'generated', seed: `guest-${randomPart}` }
    guestAvatarError.value = ''
}

function resetGuestAvatar(): void {
    guestAvatarDraft.value = defaultGuestAvatar()
    guestAvatarError.value = ''
}

async function handleGuestAvatarFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
        guestAvatarError.value = t('profiles.avatar.invalidType')
        return
    }
    if (file.size > 1024 * 1024) {
        guestAvatarError.value = t('profiles.avatar.tooLarge')
        return
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => reject(reader.error || new Error('Failed to read avatar'))
        reader.readAsDataURL(file)
    })
    guestAvatarDraft.value = { type: 'image', dataUrl }
    guestAvatarError.value = ''
}

watch(routeInviteCode, (code) => {
    inviteCodeDraft.value = code
    joinGeneration += 1
    store.disconnect()
    joinedInviteCode.value = ''
    joinError.value = ''
    joining.value = false
}, { immediate: true })

watch(() => store.error, (error) => {
    if (error !== GROUP_CHAT_MEMBER_REMOVED) return
    joinedInviteCode.value = ''
    joinError.value = 'removed'
    showAgentLinkModal.value = false
    clearPairingPoll()
})

window.addEventListener('message', handleTargetMessage)

onUnmounted(() => {
    joinGeneration += 1
    clearPairingPoll()
    window.removeEventListener('message', handleTargetMessage)
    if (targetPopup && !targetPopup.closed) targetPopup.close()
    store.disconnect()
})
</script>

<template>
    <div class="shared-group-chat-view">
        <template v-if="joined">
            <GroupChatPanel
                standalone
                @request-agent-link="openAgentLinkModal"
                @request-agent-edit="openOwnedAgentEditor"
            />
            <NModal
                v-model:show="showAgentLinkModal"
                preset="card"
                class="agent-link-modal"
                :title="t('groupChat.agentLinkTitle')"
                :bordered="false"
                :mask-closable="false"
            >
                <p class="agent-link-description">{{ t('groupChat.agentLinkDescription') }}</p>
                <div v-if="!guestAgentsAllowed" class="agent-link-warning">
                    {{ t('groupChat.guestAgentsDisabled') }}
                </div>
                <div class="agent-link-form">
                    <label for="group-chat-target-origin">{{ t('groupChat.agentLinkTargetUrl') }}</label>
                    <NInput
                        id="group-chat-target-origin"
                        v-model:value="targetOriginDraft"
                        :placeholder="t('groupChat.agentLinkTargetPlaceholder')"
                        :disabled="agentLinkStage === 'pending' || agentLinkStage === 'connecting'"
                        @keyup.enter="openTargetAuthorization"
                    />
                    <div class="agent-link-actions">
                        <NButton
                            type="primary"
                            :disabled="!guestAgentsAllowed || agentLinkStage === 'pending' || agentLinkStage === 'connecting'"
                            @click="openTargetAuthorization"
                        >
                            {{ t('groupChat.agentLinkOpenTarget') }}
                        </NButton>
                    </div>
                </div>

                <div v-if="agentLinkStatusText" class="agent-link-status" :class="`is-${agentLinkStage}`">
                    {{ agentLinkStatusText }}
                </div>
                <p v-if="agentLinkError" class="agent-link-error" role="alert">{{ agentLinkError }}</p>

                <div v-if="pairingCode" class="agent-link-code">
                    <label>{{ t('groupChat.agentLinkPairingCode') }}</label>
                    <NInput :value="pairingCode" type="textarea" :rows="4" readonly />
                    <p>{{ t('groupChat.agentLinkPairingCodeHint') }}</p>
                    <NButton secondary block @click="copyPairingCode">
                        {{ t('groupChat.agentLinkCopyCode') }}
                    </NButton>
                </div>
            </NModal>
        </template>

        <main
            v-else-if="joining"
            class="invite-loading"
            :aria-label="t('groupChat.shareJoining')"
            aria-busy="true"
        >
            <span class="invite-loading-spinner" aria-hidden="true" />
        </main>

        <main v-else class="invite-gate">
            <section class="invite-card" aria-labelledby="shared-group-chat-title">
                <div class="invite-card-top">
                    <img class="invite-logo" src="/logo.png" alt="" />
                    <LanguageSwitch class="invite-language-switch" />
                </div>
                <div class="invite-heading">
                    <p class="invite-kicker">{{ t('groupChat.title') }}</p>
                    <h1 id="shared-group-chat-title">{{ t('groupChat.shareTitle') }}</h1>
                    <p>
                        {{ collectingGuestName ? t('groupChat.shareNameSubtitle') : t('groupChat.shareSubtitle') }}
                    </p>
                </div>

                <form v-if="collectingGuestName" class="invite-form" @submit.prevent="submitGuestName">
                    <div class="guest-avatar-editor">
                        <ProfileAvatar
                            :name="guestNameDraft || 'guest'"
                            :avatar="guestAvatarDraft"
                            :size="72"
                        />
                        <div class="guest-avatar-controls">
                            <span class="guest-avatar-label">{{ t('profiles.avatar.customize') }}</span>
                            <div class="guest-avatar-actions">
                                <NButton size="small" attr-type="button" @click="guestAvatarFileInput?.click()">
                                    {{ t('profiles.avatar.upload') }}
                                </NButton>
                                <NButton size="small" attr-type="button" @click="randomizeGuestAvatar">
                                    {{ t('profiles.avatar.random') }}
                                </NButton>
                                <NButton size="small" attr-type="button" @click="resetGuestAvatar">
                                    {{ t('profiles.avatar.reset') }}
                                </NButton>
                            </div>
                            <span class="guest-avatar-hint">{{ t('profiles.avatar.hint') }}</span>
                        </div>
                        <input
                            ref="guestAvatarFileInput"
                            class="guest-avatar-file"
                            type="file"
                            accept="image/png,image/jpeg,image/webp"
                            @change="handleGuestAvatarFile"
                        >
                    </div>
                    <p v-if="guestAvatarError" class="invite-error" role="alert">
                        {{ guestAvatarError }}
                    </p>
                    <label for="group-chat-guest-name">{{ t('groupChat.yourName') }}</label>
                    <NInput
                        id="group-chat-guest-name"
                        v-model:value="guestNameDraft"
                        size="large"
                        :disabled="joining"
                        :placeholder="t('groupChat.yourName')"
                        autocomplete="name"
                        autofocus
                        clearable
                        :maxlength="120"
                    />
                    <p v-if="joinError === 'removed'" class="invite-error" role="alert">
                        {{ t('groupChat.memberRemovedNotice') }}
                    </p>
                    <p v-else-if="joinError === 'name-conflict'" class="invite-error" role="alert">
                        {{ t('groupChat.shareNameConflict') }}
                    </p>
                    <p v-else-if="joinError === 'name-reserved'" class="invite-error" role="alert">
                        {{ t('groupChat.shareNameReserved') }}
                    </p>
                    <NButton
                        attr-type="submit"
                        type="primary"
                        size="large"
                        block
                        :loading="joining"
                        :disabled="!guestNameDraft.trim()"
                    >
                        {{ t('groupChat.shareEnterRoom') }}
                    </NButton>
                </form>

                <form v-else class="invite-form" @submit.prevent="submitInvite">
                    <label for="group-chat-invite-code">{{ t('groupChat.inviteCode') }}</label>
                    <NInput
                        id="group-chat-invite-code"
                        v-model:value="inviteCodeDraft"
                        size="large"
                        :disabled="joining"
                        :placeholder="t('groupChat.inviteCodePlaceholder')"
                        autocomplete="one-time-code"
                        autofocus
                        clearable
                    />
                    <p v-if="joinError === 'invite'" class="invite-error" role="alert">
                        {{ t('groupChat.shareInvalidCode') }}
                    </p>
                    <NButton
                        attr-type="submit"
                        type="primary"
                        size="large"
                        block
                        :loading="joining"
                        :disabled="!inviteCodeDraft.trim()"
                    >
                        {{ joining ? t('groupChat.shareJoining') : t('groupChat.joinByCode') }}
                    </NButton>
                </form>

                <p class="invite-hint">{{ t('groupChat.shareCodeHint') }}</p>
            </section>
        </main>
    </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.shared-group-chat-view {
    width: 100%;
    height: calc(100 * var(--vh));
    min-height: 0;
}

:global(.agent-link-modal) {
    width: min(92vw, 560px);
}

.agent-link-description {
    margin: 0 0 18px;
    color: $text-secondary;
    line-height: 1.6;
}

.agent-link-warning,
.agent-link-status,
.agent-link-error {
    margin: 0 0 14px;
    padding: 10px 12px;
    border-radius: 9px;
    font-size: 13px;
    line-height: 1.5;
}

.agent-link-warning,
.agent-link-error {
    color: $error;
    background: rgba(208, 48, 80, 0.1);
}

.agent-link-status {
    margin-top: 16px;
    color: var(--accent-primary);
    background: rgba(var(--accent-primary-rgb), 0.1);

    &.is-connected {
        color: $success;
        background: rgba(54, 173, 106, 0.1);
    }
}

.agent-link-form,
.agent-link-code {
    display: grid;
    gap: 10px;

    label {
        color: $text-primary;
        font-size: 13px;
        font-weight: 600;
    }
}

.agent-link-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
}

.agent-link-code {
    margin-top: 18px;

    p {
        margin: 0;
        color: $text-muted;
        font-size: 12px;
        line-height: 1.5;
    }
}

.invite-loading {
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    background: $bg-main-surface;
}

.invite-loading-spinner {
    width: 24px;
    height: 24px;
    box-sizing: border-box;
    border: 2px solid $border-color;
    border-top-color: var(--accent-primary);
    border-radius: 50%;
    opacity: 0;
    animation:
        invite-loading-reveal 0s linear 200ms forwards,
        invite-loading-spin 0.7s linear infinite;
}

.invite-gate {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    padding: 24px;
    overflow-y: auto;
    background:
        radial-gradient(circle at 15% 15%, rgba(var(--accent-primary-rgb), 0.16), transparent 34%),
        radial-gradient(circle at 85% 80%, rgba(var(--accent-primary-rgb), 0.1), transparent 30%),
        $bg-primary;
}

.invite-card {
    box-sizing: border-box;
    width: min(100%, 430px);
    padding: 38px;
    border: 1px solid $border-color;
    border-radius: 24px;
    background: $bg-main-surface;
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.14);
}

.invite-card-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 24px;

    .invite-logo {
        margin-bottom: 0;
    }

    .invite-language-switch {
        flex: 0 0 auto;
        width: 96px;
    }
}

.invite-logo {
    display: block;
    width: 52px;
    height: 52px;
    margin-bottom: 24px;
    border-radius: 14px;
}

.invite-heading {
    margin-bottom: 28px;

    h1 {
        margin: 5px 0 10px;
        color: $text-primary;
        font-size: clamp(26px, 5vw, 34px);
        line-height: 1.15;
        letter-spacing: -0.025em;
    }

    p {
        margin: 0;
        color: $text-secondary;
        font-size: 14px;
        line-height: 1.65;
    }

    .invite-kicker {
        color: var(--accent-primary);
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
    }
}

.invite-form {
    display: grid;
    gap: 12px;

    label {
        color: $text-secondary;
        font-size: 13px;
        font-weight: 600;
    }
}

.guest-avatar-editor {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 4px;
}

.guest-avatar-controls {
    display: grid;
    min-width: 0;
    gap: 7px;
}

.guest-avatar-label {
    color: $text-primary;
    font-size: 13px;
    font-weight: 600;
}

.guest-avatar-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}

.guest-avatar-hint {
    color: $text-muted;
    font-size: 11px;
}

.guest-avatar-file {
    display: none;
}

.invite-error {
    margin: 0;
    color: $error;
    font-size: 13px;
    line-height: 1.5;
}

.invite-hint {
    margin: 18px 0 0;
    color: $text-muted;
    font-size: 12px;
    line-height: 1.55;
    text-align: center;
}

@keyframes invite-loading-reveal {
    to {
        opacity: 1;
    }
}

@keyframes invite-loading-spin {
    to {
        transform: rotate(360deg);
    }
}

@media (max-width: 520px) {
    .invite-gate {
        padding: 16px;
    }

    .invite-card {
        padding: 28px 22px;
        border-radius: 20px;
    }

    .guest-avatar-editor {
        align-items: flex-start;
    }
}
</style>
