<script setup lang="ts">
import { computed, h, onMounted, reactive, ref } from 'vue'
import { NButton, NDataTable, NForm, NFormItem, NInput, NModal, NPopconfirm, NSelect, NSpace, NTag, useMessage, type DataTableColumns } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import {
  createManagedUser,
  deleteManagedUser,
  fetchManagedUsers,
  updateManagedUser,
  type ManagedUser,
  type UserRole,
  type UserStatus,
} from '@/api/studio/auth'

const { t } = useI18n()
const message = useMessage()

const loading = ref(false)
const saving = ref(false)
const users = ref<ManagedUser[]>([])
const profiles = ref<string[]>([])
const showModal = ref(false)
const editingUser = ref<ManagedUser | null>(null)

const form = reactive({
  username: '',
  password: '',
  role: 'admin' as UserRole,
  status: 'active' as UserStatus,
  profiles: [] as string[],
})

const roleOptions = computed(() => [
  { label: t('users.roles.admin'), value: 'admin' },
  { label: t('users.roles.superAdmin'), value: 'super_admin' },
])

const statusOptions = computed(() => [
  { label: t('users.status.active'), value: 'active' },
  { label: t('users.status.disabled'), value: 'disabled' },
])

const profileOptions = computed(() => profiles.value.map(profile => ({ label: profile, value: profile })))

function resetForm() {
  editingUser.value = null
  form.username = ''
  form.password = ''
  form.role = 'admin'
  form.status = 'active'
  form.profiles = []
}

async function loadUsers() {
  loading.value = true
  try {
    const res = await fetchManagedUsers()
    users.value = res.users
    profiles.value = res.profiles
  } catch (err: any) {
    message.error(err.message || t('users.loadFailed'))
  } finally {
    loading.value = false
  }
}

function openCreate() {
  resetForm()
  showModal.value = true
}

function openEdit(user: ManagedUser) {
  editingUser.value = user
  form.username = user.username
  form.password = ''
  form.role = user.role
  form.status = user.status
  form.profiles = [...user.profiles]
  showModal.value = true
}

async function submit() {
  if (form.username.trim().length < 2) {
    message.error(t('login.usernameTooShort'))
    return
  }
  if (!editingUser.value && form.password.length < 6) {
    message.error(t('login.passwordTooShort'))
    return
  }
  if (form.password && form.password.length < 6) {
    message.error(t('login.passwordTooShort'))
    return
  }

  saving.value = true
  try {
    const payload = {
      username: form.username.trim(),
      password: form.password || undefined,
      role: form.role,
      status: form.status,
      profiles: form.role === 'super_admin' ? [] : form.profiles,
      defaultProfile: form.profiles[0] || null,
    }
    const res = editingUser.value
      ? await updateManagedUser(editingUser.value.id, payload)
      : await createManagedUser({ ...payload, password: form.password })
    users.value = res.users
    profiles.value = res.profiles
    showModal.value = false
    resetForm()
    message.success(t('common.saved'))
  } catch (err: any) {
    message.error(err.message || t('common.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function setStatus(user: ManagedUser, status: UserStatus) {
  saving.value = true
  try {
    const res = await updateManagedUser(user.id, { status })
    users.value = res.users
    profiles.value = res.profiles
    message.success(t('common.saved'))
  } catch (err: any) {
    message.error(err.message || t('common.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function removeUser(user: ManagedUser) {
  saving.value = true
  try {
    const res = await deleteManagedUser(user.id)
    users.value = res.users
    profiles.value = res.profiles
    message.success(t('common.saved'))
  } catch (err: any) {
    message.error(err.message || t('common.deleteFailed'))
  } finally {
    saving.value = false
  }
}

function formatTime(value: number | null): string {
  if (!value) return '-'
  return new Date(value).toLocaleString()
}

const columns = computed<DataTableColumns<ManagedUser>>(() => [
  {
    title: t('users.username'),
    key: 'username',
    minWidth: 140,
  },
  {
    title: t('users.role'),
    key: 'role',
    width: 130,
    render: (row) => h(NTag, { size: 'small', type: row.role === 'super_admin' ? 'warning' : 'default' }, {
      default: () => row.role === 'super_admin' ? t('users.roles.superAdmin') : t('users.roles.admin'),
    }),
  },
  {
    title: t('users.statusLabel'),
    key: 'status',
    width: 110,
    render: (row) => h(NTag, { size: 'small', type: row.status === 'active' ? 'success' : 'error' }, {
      default: () => row.status === 'active' ? t('users.status.active') : t('users.status.disabled'),
    }),
  },
  {
    title: t('users.profiles'),
    key: 'profiles',
    minWidth: 200,
    render: (row) => row.role === 'super_admin'
      ? h('span', { class: 'muted' }, t('users.allProfiles'))
      : h(NSpace, { size: 4 }, {
        default: () => row.profiles.length
          ? row.profiles.map(profile => h(NTag, { size: 'small', bordered: false }, { default: () => profile }))
          : h('span', { class: 'muted' }, t('users.noProfiles')),
      }),
  },
  {
    title: t('users.lastLogin'),
    key: 'last_login_at',
    minWidth: 170,
    render: (row) => formatTime(row.last_login_at),
  },
  {
    title: t('common.edit'),
    key: 'actions',
    width: 280,
    fixed: 'right',
    render: (row) => h(NSpace, { size: 8 }, {
      default: () => [
        h(NButton, { size: 'small', onClick: () => openEdit(row) }, { default: () => t('common.edit') }),
        h(NButton, {
          size: 'small',
          type: row.status === 'active' ? 'warning' : 'primary',
          ghost: true,
          loading: saving.value,
          onClick: () => setStatus(row, row.status === 'active' ? 'disabled' : 'active'),
        }, { default: () => row.status === 'active' ? t('users.disable') : t('users.enable') }),
        h(NPopconfirm, { onPositiveClick: () => removeUser(row) }, {
          trigger: () => h(NButton, { size: 'small', type: 'error', ghost: true, loading: saving.value }, { default: () => t('common.delete') }),
          default: () => t('users.deleteConfirm'),
        }),
      ],
    }),
  },
])

onMounted(loadUsers)
</script>

<template>
  <div class="user-management">
    <div class="toolbar">
      <div>
        <h3 class="section-title">{{ t('users.title') }}</h3>
        <p class="section-desc">{{ t('users.description') }}</p>
      </div>
      <NButton type="primary" @click="openCreate">{{ t('users.create') }}</NButton>
    </div>

    <NDataTable
      :columns="columns"
      :data="users"
      :loading="loading"
      :bordered="false"
      :single-line="false"
      :scroll-x="1080"
      size="small"
    />

    <NModal v-model:show="showModal" preset="dialog" :title="editingUser ? t('users.edit') : t('users.create')">
      <NForm label-placement="top">
        <NFormItem :label="t('users.username')">
          <NInput v-model:value="form.username" :placeholder="t('login.usernamePlaceholder')" />
        </NFormItem>
        <NFormItem :label="editingUser ? t('users.newPasswordOptional') : t('login.newPassword')">
          <NInput v-model:value="form.password" type="password" show-password-on="click" :placeholder="t('login.passwordPlaceholder')" />
        </NFormItem>
        <NFormItem :label="t('users.role')">
          <NSelect v-model:value="form.role" :options="roleOptions" />
        </NFormItem>
        <NFormItem :label="t('users.statusLabel')">
          <NSelect v-model:value="form.status" :options="statusOptions" />
        </NFormItem>
        <NFormItem v-if="form.role !== 'super_admin'" :label="t('users.profiles')">
          <NSelect
            v-model:value="form.profiles"
            multiple
            filterable
            :options="profileOptions"
            :placeholder="t('users.profilesPlaceholder')"
          />
        </NFormItem>
      </NForm>
      <template #action>
        <NButton @click="showModal = false">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="saving" @click="submit">{{ t('common.save') }}</NButton>
      </template>
    </NModal>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.user-management {
  padding: calc(8px * var(--spacing-scale, 1)) 0;
}

.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: calc(16px * var(--spacing-scale, 1));
  margin-bottom: 16px;
}

.section-title {
  margin: 0 0 6px;
  font-size: calc(var(--font-size-base, 14px) * 16 / 14);
  font-weight: 600;
  color: $text-primary;
}

.section-desc {
  margin: 0;
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
  color: $text-muted;
}

:deep(.muted) {
  color: $text-muted;
}
</style>
