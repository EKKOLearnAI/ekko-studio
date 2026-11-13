<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { NAlert, NButton, NForm, NFormItem, NInput, NSpace } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import WeChatQrPanel from './WeChatQrPanel.vue'
import {
  bindDeviceAccount,
  completeDeviceLogin,
  createDeviceAccount,
  deviceAuthErrorKey,
  type DeviceLoginChoice,
  type DeviceLoginPayload,
  type DeviceLoginSession,
} from '@/api/studio/device-login'

defineProps<{ baseUrl: string }>()
const emit = defineEmits<{ signedIn: [session: DeviceLoginSession] }>()
const { t } = useI18n()
const controller = new AbortController()
const qrGeneration = ref(0)
const pending = ref(false)
const error = ref('')
const choice = ref<DeviceLoginChoice | null>(null)
const step = ref<'choose' | 'bind' | 'create'>('choose')
const identifier = ref('')
const password = ref('')
const phone = ref('')
let payload: DeviceLoginPayload | null = null
const canBind = computed(() => choice.value?.options.includes('bind_by_credentials'))
const canCreate = computed(() => choice.value?.options.includes('create_local_user'))

onBeforeUnmount(() => {
  controller.abort()
  payload = null
  password.value = ''
})

async function handleApproved(input: DeviceLoginPayload) {
  pending.value = true
  error.value = ''
  try {
    const result = await completeDeviceLogin(input, controller.signal)
    if (controller.signal.aborted) return
    if ('token' in result) {
      emit('signedIn', result)
    } else if (result.status === 'needs_choice') {
      payload = input
      choice.value = result
      phone.value = result.profile.phone || ''
    } else {
      error.value = t('login.deviceLoginFailed')
    }
  } catch (err) {
    if (!controller.signal.aborted) error.value = t(deviceAuthErrorKey(err))
  } finally {
    pending.value = false
  }
}

function select(next: typeof step.value) {
  step.value = next
  identifier.value = ''
  password.value = ''
  error.value = ''
}

function rescan() {
  payload = null
  choice.value = null
  select('choose')
  qrGeneration.value++
}

async function submit() {
  if (!payload || pending.value) return
  if (!identifier.value.trim() || !password.value) {
    error.value = t('login.credentialsRequired')
    return
  }
  pending.value = true
  error.value = ''
  try {
    const result = step.value === 'create'
      ? await createDeviceAccount({ ...payload, username: identifier.value.trim(), password: password.value, phone: phone.value.trim() || undefined }, controller.signal)
      : await bindDeviceAccount({ ...payload, identifier: identifier.value.trim(), password: password.value }, controller.signal)
    if (!controller.signal.aborted) {
      payload = null
      password.value = ''
      emit('signedIn', result)
    }
  } catch (err) {
    if (!controller.signal.aborted) error.value = t(deviceAuthErrorKey(err))
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <NSpace vertical align="start">
    <WeChatQrPanel v-if="!choice" :key="qrGeneration" :base-url="baseUrl" @approved="handleApproved" />
    <span v-if="pending && !choice" role="status">{{ t('login.deviceLoginSyncing') }}</span>
    <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
    <NButton v-if="error && !choice" @click="rescan">{{ t('login.wechatQrRefresh') }}</NButton>

    <template v-if="choice && step === 'choose'">
      <span>{{ t('login.choiceDesc') }}</span>
      <NButton v-if="canBind" @click="select('bind')">{{ t('login.choiceBindByCredentials') }}</NButton>
      <NButton v-if="canCreate" @click="select('create')">{{ t('login.choiceCreateUser') }}</NButton>
    </template>
    <NForm v-else-if="choice" label-placement="top" @submit.prevent="submit">
      <NFormItem :label="t(step === 'create' ? 'login.username' : 'login.credentialIdentifier')">
        <NInput v-model:value="identifier" :placeholder="t(step === 'create' ? 'login.username' : 'login.credentialIdentifier')" />
      </NFormItem>
      <NFormItem :label="t('login.passwordPlaceholder')">
        <NInput v-model:value="password" type="password" :placeholder="t('login.passwordPlaceholder')" />
      </NFormItem>
      <NFormItem v-if="step === 'create'" :label="t('login.newPhone')">
        <NInput v-model:value="phone" :placeholder="t('login.newPhone')" />
      </NFormItem>
      <NSpace>
        <NButton :disabled="pending" @click="select('choose')">{{ t('common.cancel') }}</NButton>
        <NButton attr-type="submit" type="primary" :loading="pending">{{ t('common.confirm') }}</NButton>
      </NSpace>
    </NForm>
  </NSpace>
</template>
