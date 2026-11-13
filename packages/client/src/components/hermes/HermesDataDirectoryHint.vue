<script setup lang="ts">
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
</script>

<template>
  <div data-testid="hermes-data-directory-env-hint" class="data-directory-env-hint">
    <p>{{ t('runtimeVersions.dataDirectoryEnvDescription') }}</p>
    <details>
      <summary>{{ t('runtimeVersions.dataDirectoryEnvInstructions') }}</summary>
      <div class="data-directory-env-platforms">
        <div class="data-directory-env-platform">
          <strong>{{ t('runtimeVersions.dataDirectoryEnvWindows') }}</strong>
          <code>[Environment]::SetEnvironmentVariable("HERMES_HOME", "$HOME\.hermes", "User")</code>
        </div>
        <div class="data-directory-env-platform">
          <strong>{{ t('runtimeVersions.dataDirectoryEnvMacos') }}</strong>
          <code>launchctl setenv HERMES_HOME "$HOME/.hermes"</code>
          <code>echo 'export HERMES_HOME="$HOME/.hermes"' &gt;&gt; ~/.zshrc</code>
        </div>
        <div class="data-directory-env-platform">
          <strong>{{ t('runtimeVersions.dataDirectoryEnvLinux') }}</strong>
          <code>echo 'export HERMES_HOME="$HOME/.hermes"' &gt;&gt; ~/.profile</code>
        </div>
        <div class="data-directory-env-platform">
          <strong>{{ t('runtimeVersions.dataDirectoryEnvDocker') }}</strong>
          <code>HERMES_HOME=/home/agent/.hermes</code>
        </div>
      </div>
      <p class="data-directory-env-restart">
        {{ t('runtimeVersions.dataDirectoryEnvRestart') }}
      </p>
    </details>
  </div>
</template>

<style scoped lang="scss">
.data-directory-env-hint {
  padding: calc(10px * var(--spacing-scale, 1)) calc(12px * var(--spacing-scale, 1));
  border: var(--border-width, 1px) solid var(--border-color);
  border-radius: var(--radius-component, 6px);
  color: var(--text-color-2);
  font-size: calc(var(--font-size-base, 14px) * 12 / 14);

  p {
    margin: 0;
    line-height: var(--line-height, 1.55);
  }

  details {
    margin-top: 8px;
  }

  summary {
    width: fit-content;
    cursor: pointer;
    color: var(--primary-color);
    user-select: text;
  }
}

.data-directory-env-platforms {
  display: flex;
  flex-direction: column;
  gap: calc(10px * var(--spacing-scale, 1));
  margin-top: 10px;
}

.data-directory-env-platform {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: calc(5px * var(--spacing-scale, 1));

  strong {
    color: var(--text-color-2);
  }

  code {
    display: block;
    padding: calc(6px * var(--spacing-scale, 1)) calc(8px * var(--spacing-scale, 1));
    overflow-x: auto;
    border-radius: var(--radius-component, 4px);
    background: var(--hover-color);
    color: var(--text-color-1);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    line-height: var(--line-height, 1.45);
    white-space: pre;
    user-select: text;
  }
}

.data-directory-env-restart {
  margin-top: 10px !important;
  color: var(--text-color-3);
}
</style>
