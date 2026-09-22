<script setup lang="ts">
import { computed, ref } from 'vue'
import { NModal, NForm, NFormItem, NInput, NButton, NSelect, NSwitch, NText, useMessage } from 'naive-ui'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useI18n } from 'vue-i18n'

const emit = defineEmits<{
  close: []
  saved: []
}>()

const { t } = useI18n()
const profilesStore = useProfilesStore()
const message = useMessage()

const showModal = ref(true)
const loading = ref(false)
const name = ref('')
const clone = ref(false)
const nameValidationMessage = ref('')

// 克隆来源默认当前 profile —— 与开关打开前的旧行为一致
const cloneFrom = ref<string | null>(profilesStore.activeProfileName || 'default')
const cloneOptions = computed(() => profilesStore.profiles.map(profile => ({
  label: profile.name === profilesStore.activeProfileName
    ? t('profiles.cloneSourceCurrent', { name: profile.name })
    : profile.name,
  value: profile.name,
})))

function handleNameInput(value: string) {
  // 过滤掉不符合规则的字符，只保留小写字母、数字、下划线和连字符
  const filtered = value.toLowerCase().replace(/[^a-z0-9_-]/g, '')
  if (filtered !== value) {
    nameValidationMessage.value = t('profiles.nameValidation')
  } else {
    nameValidationMessage.value = ''
  }
  name.value = filtered
}

async function handleSave() {
  if (!name.value) {
    message.warning(t('profiles.namePlaceholder'))
    return
  }

  if (!/^[a-z0-9_-]+$/.test(name.value)) {
    message.error(t('profiles.nameValidation'))
    return
  }

  if (clone.value && !cloneFrom.value) {
    message.warning(t('profiles.cloneSourcePlaceholder'))
    return
  }

  loading.value = true
  try {
    const res = await profilesStore.createProfile(name.value.trim(), clone.value ? cloneFrom.value : null)
    if (res.success) {
      const stripped = res.strippedCredentials ?? []
      const disabled = res.disabledPlatforms ?? []
      const cfgStripped = res.strippedConfigCredentials ?? []
      if (clone.value && (stripped.length > 0 || disabled.length > 0 || cfgStripped.length > 0)) {
        const parts: string[] = []
        if (stripped.length > 0) parts.push(t('profiles.cloneStrippedCredentials', { count: stripped.length, list: stripped.join(', ') }))
        if (disabled.length > 0) parts.push(t('profiles.cloneDisabledPlatforms', { count: disabled.length, list: disabled.join(', ') }))
        if (cfgStripped.length > 0) parts.push(t('profiles.cloneStrippedConfigCredentials', { count: cfgStripped.length, list: cfgStripped.join(', ') }))
        message.info(`${t('profiles.createSuccess', { name: name.value.trim() })}\n${parts.join('\n')}`, { duration: 6000 })
      } else {
        message.success(t('profiles.createSuccess', { name: name.value.trim() }))
      }
      emit('saved')
    } else {
      const errorMsg = res.error || t('profiles.createFailed')
      message.error(errorMsg)
    }
  } finally {
    loading.value = false
  }
}

function handleClose() {
  showModal.value = false
  setTimeout(() => emit('close'), 200)
}
</script>

<template>
  <NModal
    v-model:show="showModal"
    preset="card"
    :title="t('profiles.create')"
    :style="{ width: 'min(420px, calc(100vw - 32px))' }"
    :mask-closable="!loading"
    @after-leave="emit('close')"
  >
    <NForm label-placement="top">
      <NFormItem :label="t('profiles.name')" required>
        <NInput
          v-model:value="name"
          :placeholder="t('profiles.namePlaceholder')"
          @input="handleNameInput"
        />
      </NFormItem>
      <NText v-if="nameValidationMessage" depth="3" type="warning" style="font-size: 12px;">
        {{ nameValidationMessage }}
      </NText>

      <NFormItem :label="t('profiles.cloneFromProfile')">
        <NSwitch v-model:value="clone" />
      </NFormItem>
      <NFormItem v-if="clone" :label="t('profiles.cloneSource')">
        <NSelect
          v-model:value="cloneFrom"
          :options="cloneOptions"
          :placeholder="t('profiles.cloneSourcePlaceholder')"
          filterable
        />
      </NFormItem>
      <NText v-if="clone" depth="3" style="font-size: 12px;">
        {{ t('profiles.cloneCleanupNotice') }}
      </NText>
    </NForm>

    <template #footer>
      <div class="modal-footer">
        <NButton @click="handleClose">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="loading" @click="handleSave">
          {{ t('common.create') }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>

<style scoped lang="scss">
.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
