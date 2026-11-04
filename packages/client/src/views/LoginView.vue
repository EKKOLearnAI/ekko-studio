<script setup lang="ts">
import { deploymentUrl } from '@/utils/deployment-url'
import { ref, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { setApiKey, clearApiKey, hasApiKey } from "@/api/client";
import { fetchAuthStatus, loginWithPassword } from "@/api/studio/auth";
import { desktopBridge, isDesktopShell } from "@/utils/desktop-bridge";
import { resolveLoginRedirect } from "@/utils/login-redirect";
import { useTheme } from "@/composables/useTheme";

const { t } = useI18n();
const router = useRouter();
const route = useRoute();
const { activateUserTheme } = useTheme();

const username = ref("");
const password = ref("");
const loading = ref(false);
const errorMsg = ref("");
const showLockResetHint = ref(false);
const desktopShell = isDesktopShell() && desktopBridge()?.remoteMode !== true;

if (desktopShell) {
  // Desktop login is a recovery path. Drop stale JWTs before any background
  // request can reuse them and show an unrelated expiry notice.
  clearApiKey();
} else if (hasApiKey()) {
  router.replace(resolveLoginRedirect(route.query.redirect));
}

onMounted(async () => {
  try {
    await fetchAuthStatus();
  } catch {
    // Login remains available; the submit request will surface connection errors.
  }
});

async function handleLogin() {
  await handlePasswordLogin();
}

async function handlePasswordLogin() {
  if (!username.value.trim() || !password.value) {
    errorMsg.value = t("login.credentialsRequired");
    return;
  }

  loading.value = true;
  errorMsg.value = "";
  showLockResetHint.value = false;

  try {
    const session = await loginWithPassword(username.value.trim(), password.value);
    setApiKey(session.token);
    activateUserTheme(session.userId, session.theme);
    router.replace(resolveLoginRedirect(route.query.redirect));
  } catch (err: any) {
    if (err.status === 429 || err.status === 503) {
      errorMsg.value = t("login.tooManyAttempts");
      showLockResetHint.value = true;
    } else {
      errorMsg.value = err.message || t("login.invalidCredentials");
    }
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-view">
    <div class="login-card">
      <div class="login-logo">
        <img :src="deploymentUrl('/logo.png')" alt="Ekko Studio" width="80" height="80" />
      </div>
      <h1 class="login-title">{{ t("login.title") }}</h1>
      <p class="login-desc">{{ t("login.description") }}</p>
      <p class="login-default-hint">{{ t("login.defaultCredentialsHint") }}</p>

      <form class="login-form" @submit.prevent="handleLogin">
        <input
          v-model="username"
          type="text"
          class="login-input"
          :placeholder="t('login.usernamePlaceholder')"
          autofocus
        />
        <input
          v-model="password"
          type="password"
          class="login-input"
          :placeholder="t('login.passwordPlaceholder')"
          @keyup.enter="handleLogin"
        />

        <div v-if="errorMsg" class="login-error">{{ errorMsg }}</div>
        <div v-if="showLockResetHint" class="login-lock-hint">
          <template v-if="desktopShell">
            <span>{{ t("login.desktopLockResetHint") }}</span>
          </template>
          <template v-else>
            <span>{{ t("login.lockResetHint") }}</span>
            <code>hermes-web-ui clear-login-locks --restart</code>
            <span>{{ t("login.defaultLoginResetHint") }}</span>
            <code>hermes-web-ui reset-default-login</code>
          </template>
        </div>
        <button type="submit" class="login-btn" :disabled="loading">
          {{ loading ? "..." : t("login.submit") }}
        </button>
      </form>
    </div>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.login-view {
  height: calc(100 * var(--vh));
  display: flex;
  align-items: center;
  justify-content: center;
  background: $bg-primary;
}

.login-card {
  width: 480px;
  max-width: calc(100vw - 32px);
  padding: 56px;
  border: var(--border-width, 1px) solid $border-color;
  border-radius: $radius-lg;
  background: var(--theme-card-bg, $bg-card);
  text-align: center;

  @media (max-width: $breakpoint-mobile) {
    padding: calc(32px * var(--spacing-scale, 1)) calc(24px * var(--spacing-scale, 1));
  }
}

.login-logo {
  margin-bottom: 24px;

  img {
    border-radius: 25%;
  }
}

.login-title {
  font-size: calc(var(--font-size-base, 14px) * 26 / 14);
  font-weight: 600;
  color: $text-primary;
  margin: 0 0 10px;
}

.login-desc {
  font-size: calc(var(--font-size-base, 14px) * 14 / 14);
  color: $text-muted;
  margin: 0 0 12px;
  line-height: var(--line-height, 1.6);
}

.login-default-hint {
  margin: 0 0 28px;
  font-family: var(--font-code, $font-code);
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
  color: $text-secondary;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: calc(14px * var(--spacing-scale, 1));
}

.login-input {
  width: 100%;
  padding: calc(14px * var(--spacing-scale, 1)) calc(16px * var(--spacing-scale, 1));
  border: var(--border-width, 1px) solid $border-color;
  border-radius: $radius-sm;
  font-size: calc(var(--font-size-base, 14px) * 15 / 14);
  color: $text-primary;
  background: var(--theme-input-bg, $bg-input);
  outline: none;
  transition: border-color $transition-fast;
  box-sizing: border-box;
  font-family: var(--font-code, $font-code);

  &::placeholder {
    color: $text-muted;
  }

  &:focus {
    border-color: $accent-primary;
  }
}

.login-error {
  font-size: calc(var(--font-size-base, 14px) * 13 / 14);
  color: $error;
  text-align: start;
}

.login-lock-hint {
  padding: calc(10px * var(--spacing-scale, 1)) calc(12px * var(--spacing-scale, 1));
  border: var(--border-width, 1px) solid rgba(var(--warning-rgb), 0.35);
  border-radius: $radius-sm;
  background: rgba(var(--warning-rgb), 0.08);
  color: $text-secondary;
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);
  line-height: var(--line-height, 1.5);
  text-align: start;

  code {
    display: block;
    margin-top: 4px;
    color: $text-primary;
    font-family: var(--font-code, $font-code);
    word-break: break-all;
  }
}

.login-btn {
  width: 100%;
  padding: calc(14px * var(--spacing-scale, 1));
  border: none;
  border-radius: $radius-sm;
  background: $text-primary;
  color: var(--text-on-accent);
  font-size: calc(var(--font-size-base, 14px) * 15 / 14);
  font-weight: 500;
  cursor: pointer;
  transition: opacity $transition-fast;

  &:hover {
    opacity: 0.85;
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}
</style>
