<script setup lang="ts">
import { ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { NButton, NModal } from "naive-ui";
import { fetchCurrentUser } from "@/api/studio/auth";
import { getApiKey } from "@/api/client";
import { desktopBridge } from "@/utils/desktop-bridge";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const show = ref(false);
const loading = ref(false);
const checkedToken = ref("");
const promptedUserId = ref<number | null>(null);

function dismissalKey(userId: number): string {
  return `hermes_default_credentials_prompt_dismissed_${userId}`;
}

async function checkDefaultCredentials() {
  const desktop = desktopBridge();
  if (desktop?.isDesktop === true && desktop.remoteMode !== true) {
    show.value = false;
    return;
  }

  if (route.name === "login") {
    show.value = false;
    return;
  }

  const token = getApiKey();
  if (!token || token === checkedToken.value) return;
  checkedToken.value = token;

  loading.value = true;
  try {
    const user = await fetchCurrentUser();
    promptedUserId.value = user.id;
    const dismissed = sessionStorage.getItem(dismissalKey(user.id)) === "1";
    show.value = !!user.requiresCredentialChange && !dismissed;
  } catch {
    show.value = false;
  } finally {
    loading.value = false;
  }
}

function remindLater() {
  if (promptedUserId.value != null) {
    sessionStorage.setItem(dismissalKey(promptedUserId.value), "1");
  }
  show.value = false;
}

function goToAccountSettings() {
  show.value = false;
  router.push({ name: "hermes.settings", query: { tab: "account" } });
}

watch(() => route.fullPath, () => {
  void checkDefaultCredentials();
}, { immediate: true });
</script>

<template>
  <NModal
    v-model:show="show"
    preset="dialog"
    :title="t('login.defaultCredentialTitle')"
    :mask-closable="false"
  >
    <p class="credential-warning-text">
      {{ t("login.defaultCredentialMessage") }}
    </p>
    <template #action>
      <NButton :disabled="loading" @click="remindLater">
        {{ t("login.defaultCredentialLater") }}
      </NButton>
      <NButton type="primary" :loading="loading" @click="goToAccountSettings">
        {{ t("login.defaultCredentialAction") }}
      </NButton>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
.credential-warning-text {
  margin: 0;
  line-height: 1.6;
}
</style>
