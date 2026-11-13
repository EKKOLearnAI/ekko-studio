<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { NAlert, NButton, NForm, NFormItem, NInput, NModal, NPopconfirm, NSpace } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import WeChatQrPanel from './WeChatQrPanel.vue'
import { fetchAuthStatus, fetchCurrentUser, type CurrentUser } from '@/api/studio/auth'
import {
  bindAccountPhone,
  bindDeviceAccount,
  deviceAuthErrorKey,
  setInitialAccountPassword,
  unbindAccountPhone,
  unbindDeviceAccount,
  type DeviceLoginPayload,
} from '@/api/studio/device-login'
import { setApiKey } from '@/api/client'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useMessage } from '@/composables/useAppMessage'

const { t } = useI18n()
const message = useMessage()
const baseUrl = ref('')
const user = ref<CurrentUser | null>(null)
const dialog = ref<'bind' | 'unbind' | 'phone' | 'password' | null>(null)
const approved = shallowRef<DeviceLoginPayload | null>(null)
const password = ref('')
const repeatPassword = ref('')
const phone = ref('')
const error = ref('')
const saving = ref(false)
let submission: AbortController | null = null

onMounted(async () => {
  try {
    baseUrl.value = (await fetchAuthStatus()).tokenPlatformBaseUrl || ''
    if (baseUrl.value) user.value = await fetchCurrentUser()
  } catch {
    // Leave the ordinary account controls available if this integration is unavailable.
  }
})

function close() {
  submission?.abort()
  submission = null
  dialog.value = null
  approved.value = null
  password.value = ''
  repeatPassword.value = ''
  error.value = ''
}

onBeforeUnmount(close)

function open(action: NonNullable<typeof dialog.value>) {
  close()
  phone.value = user.value?.phone_number || ''
  dialog.value = action
}

async function save() {
  const action = dialog.value
  const account = user.value
  if (!account || !action || saving.value) return
  if (action === 'password' && password.value !== repeatPassword.value) {
    error.value = t('login.passwordMismatch')
    return
  }
  if (action === 'password' && password.value.length < 6) {
    error.value = t('login.passwordTooShort')
    return
  }

  saving.value = true
  error.value = ''
  let binding: AbortController | null = null
  try {
    if (action === 'phone') {
      const result = await bindAccountPhone(phone.value.trim())
      account.phone_number = result.phone_number
    } else if (action === 'password') {
      await setInitialAccountPassword(password.value)
      account.requiresPasswordSetup = false
    } else if (action === 'unbind') {
      await unbindDeviceAccount(password.value)
      account.wechat_bound = false
    } else if (approved.value) {
      binding = new AbortController()
      submission = binding
      const session = await bindDeviceAccount({
        ...approved.value,
        identifier: account.username,
        password: password.value,
      }, binding.signal, true)
      if (binding.signal.aborted) return
      if (session.user.id !== account.id) throw new Error(t('login.deviceLoginFailed'))
      account.wechat_bound = true
      account.phone_number = session.user.phone_number ?? account.phone_number
      const activeProfile = session.activeProfile ?? session.user.active_profile
      if (activeProfile) {
        const profiles = useProfilesStore()
        profiles.activeProfileName = activeProfile
        localStorage.setItem('hermes_active_profile_name', activeProfile)
      }
      setApiKey(session.token)
      if (activeProfile) void useProfilesStore().fetchProfiles()
    }
    close()
    message.success(t('settings.saved'))
  } catch (err) {
    if (!binding?.signal.aborted) error.value = t(deviceAuthErrorKey(err, 'settings.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function removePhone() {
  saving.value = true
  try {
    await unbindAccountPhone()
    if (user.value) user.value.phone_number = null
    message.success(t('settings.saved'))
  } catch (err) {
    message.error(t(deviceAuthErrorKey(err, 'settings.saveFailed')))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section v-if="baseUrl && user" class="wechat-account-settings">
    <h3>{{ t('settings.wechatAccount.title') }}</h3>
    <NSpace align="center">
      <span>{{ t(user.wechat_bound ? 'settings.wechatAccount.bound' : 'settings.wechatAccount.notBound') }}</span>
      <NButton v-if="user.requiresPasswordSetup" size="small" @click="open('password')">
        {{ t('login.setupPassword') }}
      </NButton>
      <NButton v-if="user.wechat_bound" size="small" :disabled="user.requiresPasswordSetup" @click="open('unbind')">
        {{ t('settings.wechatAccount.unbind') }}
      </NButton>
      <NButton v-else size="small" @click="open('bind')">{{ t('settings.wechatAccount.bind') }}</NButton>
    </NSpace>
    <NSpace align="center">
      <span>{{ user.phone_number ? t('settings.wechatAccount.phoneBound', { phone: user.phone_number }) : t('settings.wechatAccount.noPhone') }}</span>
      <NButton size="small" @click="open('phone')">{{ t('settings.wechatAccount.editPhone') }}</NButton>
      <NPopconfirm v-if="user.phone_number && !user.wechat_bound" @positive-click="removePhone">
        <template #trigger>
          <NButton size="small" :loading="saving">{{ t('settings.wechatAccount.removePhone') }}</NButton>
        </template>
        {{ t('settings.wechatAccount.removePhoneConfirm') }}
      </NPopconfirm>
    </NSpace>
    <NModal
      :show="dialog !== null"
      preset="dialog"
      :mask-closable="false"
      :closable="!saving"
      :close-on-esc="!saving"
      :title="t(dialog === 'phone' ? 'settings.wechatAccount.editPhone' : dialog === 'password' ? 'login.setupPassword' : dialog === 'unbind' ? 'settings.wechatAccount.unbind' : 'settings.wechatAccount.bind')"
      @update:show="visible => { if (!visible && !saving) close() }"
    >
      <WeChatQrPanel v-if="dialog === 'bind' && !approved" :base-url="baseUrl" @approved="approved = $event" />
      <NForm v-else-if="dialog" label-placement="top" @submit.prevent="save">
        <p v-if="dialog === 'unbind'">{{ t('settings.wechatAccount.unbindConfirm') }}</p>
        <NFormItem v-if="dialog === 'phone'" :label="t('settings.wechatAccount.phone')">
          <NInput v-model:value="phone" :input-props="{ type: 'tel', autocomplete: 'tel' }" :placeholder="t('settings.wechatAccount.phone')" />
        </NFormItem>
        <template v-else>
          <NFormItem :label="t(dialog === 'password' ? 'login.newPassword' : 'login.currentPassword')">
            <NInput v-model:value="password" type="password" :placeholder="t(dialog === 'password' ? 'login.newPassword' : 'login.currentPassword')" />
          </NFormItem>
          <NFormItem v-if="dialog === 'password'" :label="t('login.confirmPassword')">
            <NInput v-model:value="repeatPassword" type="password" :placeholder="t('login.confirmPassword')" />
          </NFormItem>
        </template>
        <NAlert v-if="error" type="error" role="alert">{{ error }}</NAlert>
        <NButton attr-type="submit" type="primary" :loading="saving" :disabled="dialog === 'phone' ? !phone.trim() : !password">
          {{ t('common.confirm') }}
        </NButton>
      </NForm>
    </NModal>
  </section>
</template>

<style scoped lang="scss">
.wechat-account-settings {
  display: grid;
  gap: 12px;
  margin: 24px 0;
}

.wechat-account-settings h3 {
  margin: 0;
}
</style>
