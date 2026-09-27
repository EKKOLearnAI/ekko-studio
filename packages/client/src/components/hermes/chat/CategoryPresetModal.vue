<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { NAlert, NButton, NInput, NModal, NRadioButton, NRadioGroup, NSelect, useMessage } from "naive-ui";
import { useI18n } from "vue-i18n";
import {
  createSessionCategoryWithPreset,
  updateSessionCategoryPreset,
  type SessionCategory,
  type SessionCategoryPreset,
} from "@/api/studio/sessions";
import { loadDshSessionPresetChoices, type DshSessionPresetChoice } from "@/components/coding-agents/dsh/session-preset-catalog";
import { useAppStore } from "@/stores/hermes/app";
import { useProfilesStore } from "@/stores/hermes/profiles";
import FolderPicker from "./FolderPicker.vue";
import {
  CATEGORY_NAME_MAX_LENGTH,
  NEW_CHAT_AGENT_OPTIONS,
  compactCategoryPreset,
  effectiveNewChatMode,
  hasLaunchModeChoice,
  isNewChatProviderAllowedFor,
  normalizeCategoryName,
  presetBaseUrlCarriesCredentials,
  presetWarningMessageKey,
  resolveCategoryPreset,
  usesProviderModel,
  validateCategoryName,
  type CategoryNameError,
  type CategoryPresetWarning,
  type CategoryPresetWarningField,
  type NewChatAgentId,
  type NewChatAgentMode,
} from "./category-new-chat-preset";

const props = defineProps<{
  /** "create" shows a required Name field; "edit" edits an existing category's preset. */
  mode: "create" | "edit";
  category?: SessionCategory | null;
  existingNames: readonly string[];
  /** false for users who may not write shared presets: "create" then shows only the Name field. */
  canEditPreset?: boolean;
}>();
const show = defineModel<boolean>("show", { required: true });
const emit = defineEmits<{ saved: [category: SessionCategory] }>();

const { t } = useI18n();
const message = useMessage();
const appStore = useAppStore();
const profilesStore = useProfilesStore();

const name = ref("");
const nameError = ref<CategoryNameError | null>(null);
const agent = ref<NewChatAgentId | "">("");
const agentMode = ref<NewChatAgentMode | "">("");
const agentPreset = ref("");
const profile = ref("");
const modelKind = ref<"model" | "moa">("model");
const provider = ref("");
const model = ref("");
const apiMode = ref("");
const baseUrl = ref("");
const workspace = ref<string | null>(null);
const baseUrlError = ref(false);
const saving = ref(false);
const loading = ref(false);
const dshPresets = ref<DshSessionPresetChoice[] | null>(null);

const editsPreset = computed(() => props.canEditPreset !== false);
const storedPreset = computed(() => (props.mode === "edit" ? props.category?.preset || null : null));

function resetFromPreset(preset: SessionCategoryPreset | null) {
  agent.value = (preset?.agent as NewChatAgentId | undefined) || "";
  agentMode.value = preset?.agentMode || "";
  agentPreset.value = preset?.agentPreset || "";
  profile.value = preset?.profile || "";
  modelKind.value = preset?.modelKind === "moa" ? "moa" : "model";
  provider.value = preset?.modelKind === "moa" ? "moa" : preset?.provider || "";
  model.value = preset?.model || "";
  apiMode.value = preset?.apiMode || "";
  baseUrl.value = preset?.baseUrl || "";
  workspace.value = preset?.workspace || null;
  baseUrlError.value = false;
}

async function loadDshPresets() {
  if (dshPresets.value) return;
  try {
    dshPresets.value = await loadDshSessionPresetChoices();
  } catch {
    dshPresets.value = null;
  }
}

watch(show, async (visible) => {
  if (!visible) return;
  name.value = "";
  nameError.value = null;
  resetFromPreset(storedPreset.value);
  loading.value = true;
  try {
    if (profilesStore.profiles.length === 0) await profilesStore.fetchProfiles();
    if (appStore.modelGroups.length === 0 && appStore.profileModelGroups.length === 0) await appStore.loadModels();
    if (agent.value === "dsh") await loadDshPresets();
  } finally {
    loading.value = false;
  }
}, { immediate: true });

// Agent "Default" means whatever agent the New Chat panel has when it opens (the last
// one used), which the form cannot know. So "Default" applies no agent-specific rule
// here: every provider of the profile is offered and no agent-specific warning is
// shown. The panel validates against the agent actually in effect and shows the
// per-field stale warnings then. Only field visibility follows Hermes (the panel's
// first-run default).
const effectiveAgent = computed<NewChatAgentId>(() => agent.value || "hermes");
const effectiveMode = computed<NewChatAgentMode>(() =>
  effectiveNewChatMode(effectiveAgent.value, agentMode.value || "scoped"),
);
const profileNames = computed(() =>
  (profilesStore.profiles.length > 0 ? profilesStore.profiles : [{ name: "default" }]).map((item) => item.name),
);
const defaultProfile = computed(() =>
  profilesStore.activeProfileName ||
  profilesStore.profiles.find((item) => item.active)?.name ||
  profileNames.value[0] ||
  "default",
);
const effectiveProfile = computed(() =>
  profile.value && profileNames.value.includes(profile.value) ? profile.value : defaultProfile.value,
);

function profileGroups(profileName: string) {
  return appStore.profileModelGroups.find((entry) => entry.profile === profileName)?.groups || [];
}

function selectableGroups(profileName: string, agentId: NewChatAgentId, mode: NewChatAgentMode) {
  return profileGroups(profileName).filter((group) => isNewChatProviderAllowedFor(group, agentId, mode));
}

/** Groups the form offers: unfiltered for agent "Default", else the panel's rule for that agent/mode. */
function formGroups(profileName: string, agentId: NewChatAgentId | "", mode: NewChatAgentMode) {
  return agentId ? selectableGroups(profileName, agentId, mode) : profileGroups(profileName);
}

const groups = computed(() => formGroups(effectiveProfile.value, agent.value, effectiveMode.value));
const moaGroup = computed(() => groups.value.find((group) => group.provider === "moa"));
const showModelKind = computed(() =>
  effectiveAgent.value === "hermes" && (Boolean(moaGroup.value?.models.length) || modelKind.value === "moa"),
);
const showProviderModel = computed(() => usesProviderModel(effectiveAgent.value, effectiveMode.value));
const isScopedCodingAgent = computed(() => effectiveAgent.value !== "hermes" && effectiveMode.value === "scoped");
const selectedGroup = computed(() =>
  modelKind.value === "moa" ? moaGroup.value : groups.value.find((group) => group.provider === provider.value),
);
const showBaseUrl = computed(() =>
  isScopedCodingAgent.value && Boolean(provider.value) && modelKind.value !== "moa" && !selectedGroup.value?.base_url,
);

const defaultOption = computed(() => ({ label: t("chat.categoryPresetDefault"), value: "" }));
function withStaleOption(options: Array<{ label: string; value: string }>, current: string) {
  if (!current || options.some((option) => option.value === current)) return options;
  return [...options, { label: t("chat.presetValueUnavailable", { value: current }), value: current }];
}

const agentOptions = computed(() => [defaultOption.value, ...NEW_CHAT_AGENT_OPTIONS]);
const agentModeOptions = computed(() => [
  { label: t("chat.categoryPresetDefault"), value: "" },
  { label: t("codingAgents.launchModeGlobal"), value: "global" },
  { label: t("codingAgents.launchModeScoped"), value: "scoped" },
]);
const profileOptions = computed(() => withStaleOption(
  [defaultOption.value, ...profileNames.value.map((item) => ({ label: item, value: item }))],
  profile.value,
));
const providerOptions = computed(() => withStaleOption(
  [
    defaultOption.value,
    ...groups.value
      .filter((group) => group.provider !== "moa")
      .map((group) => ({ label: group.label || group.provider, value: group.provider })),
  ],
  provider.value,
));
const modelOptions = computed(() => withStaleOption(
  [
    defaultOption.value,
    ...(selectedGroup.value?.models || []).map((item) => ({
      label: appStore.displayModelName(item, selectedGroup.value?.provider),
      value: item,
    })),
  ],
  model.value,
));
const apiModeOptions = computed(() => [
  defaultOption.value,
  { label: t("codingAgents.protocolOpenAiChat"), value: "chat_completions" },
  { label: t("codingAgents.protocolOpenAiResponses"), value: "codex_responses" },
  { label: t("codingAgents.protocolAnthropicMessages"), value: "anthropic_messages" },
]);
const dshPresetOptions = computed(() => withStaleOption(
  [
    defaultOption.value,
    ...(dshPresets.value || []).map((preset) => ({ label: preset.label, value: preset.id, disabled: preset.unavailable })),
  ],
  agentPreset.value,
));

function handleAgentChange(value: NewChatAgentId | "") {
  agent.value = value;
  const nextAgent = value || "hermes";
  if (!hasLaunchModeChoice(nextAgent)) agentMode.value = "";
  if (nextAgent !== "dsh") agentPreset.value = "";
  else void loadDshPresets();
  if (nextAgent !== "hermes" && modelKind.value === "moa") {
    modelKind.value = "model";
    provider.value = "";
    model.value = "";
  }
  const stillAllowed = !provider.value || formGroups(effectiveProfile.value, value, effectiveNewChatMode(nextAgent, agentMode.value || "scoped"))
    .some((group) => group.provider === provider.value);
  if (!stillAllowed) {
    provider.value = "";
    model.value = "";
  }
  if (nextAgent === "hermes") {
    apiMode.value = "";
    baseUrl.value = "";
  }
}

function handleModelKindChange(value: "model" | "moa") {
  modelKind.value = value;
  provider.value = value === "moa" ? "moa" : "";
  model.value = "";
  baseUrl.value = "";
  baseUrlError.value = false;
}

function handleProviderChange(value: string) {
  provider.value = value;
  model.value = "";
  baseUrl.value = "";
  baseUrlError.value = false;
}

function handleProfileChange(value: string) {
  profile.value = value;
}

const currentPreset = computed<SessionCategoryPreset | null>(() => {
  if (!editsPreset.value) return null;
  const agentId = effectiveAgent.value;
  const usesModel = showProviderModel.value;
  return compactCategoryPreset({
    agent: agent.value || undefined,
    agentMode: hasLaunchModeChoice(agentId) && agentMode.value ? agentMode.value : undefined,
    agentPreset: agentId === "dsh" ? agentPreset.value : undefined,
    profile: profile.value || undefined,
    modelKind: usesModel && modelKind.value === "moa" ? "moa" : undefined,
    provider: usesModel && modelKind.value !== "moa" ? provider.value : undefined,
    model: usesModel && (modelKind.value === "moa" || provider.value) ? model.value : undefined,
    apiMode: isScopedCodingAgent.value && apiMode.value ? (apiMode.value as SessionCategoryPreset["apiMode"]) : undefined,
    baseUrl: showBaseUrl.value ? baseUrl.value : undefined,
    workspace: workspace.value || undefined,
  });
});

// Same stale-value rules as the New Chat panel; only computed for display, never written back.
const warnings = computed<CategoryPresetWarning[]>(() => {
  if (loading.value) return [];
  const current = currentPreset.value;
  // A stored Base URL the form no longer shows (the provider now has its own base_url)
  // still gets the panel's warning; saving drops it, like any hidden field.
  const hiddenBaseUrl = isScopedCodingAgent.value && !showBaseUrl.value && baseUrl.value ? baseUrl.value : undefined;
  const preset = current && hiddenBaseUrl ? { ...current, baseUrl: hiddenBaseUrl } : current;
  const storedWorkspace = storedPreset.value?.workspace;
  return resolveCategoryPreset(preset, {
    // Only reached with agent "Default" (no preset agent); formGroups then applies no agent rule.
    currentAgent: "hermes",
    currentAgentMode: "scoped",
    profiles: profileNames.value,
    defaultProfile: defaultProfile.value,
    selectableGroups: (profileName, agentId, mode) => formGroups(profileName, agent.value ? agentId : "", mode),
    dshPresetIds: dshPresets.value ? dshPresets.value.filter((item) => !item.unavailable).map((item) => item.id) : undefined,
    workspaceExists: preset?.workspace && preset.workspace === storedWorkspace
      ? props.category?.preset_status?.workspace_exists
      : undefined,
    storedBaseUrlDropped: props.mode === "edit" ? props.category?.preset_status?.base_url_dropped : undefined,
  }).warnings;
});

function warningFor(field: CategoryPresetWarningField): string {
  const warning = warnings.value.find((item) => item.field === field);
  return warning ? t(presetWarningMessageKey(warning.field), { value: warning.value }) : "";
}

const nameErrorText = computed(() => {
  if (nameError.value === "required") return t("chat.categoryNameRequired");
  if (nameError.value === "tooLong") return t("chat.categoryNameTooLong");
  if (nameError.value === "duplicate") return t("chat.categoryNameDuplicate");
  return "";
});

const title = computed(() =>
  props.mode === "create"
    ? t("chat.newCategoryTitle")
    : t("chat.categoryPresetTitle", { name: props.category?.name || "" }),
);

function saveErrorText(error: any): string {
  return error?.status === 403 ? t("chat.categoryPresetForbidden") : t("chat.categoryPresetSaveFailed");
}

async function save() {
  // Enter in a field submits the form too: never while the form is still loading or saving.
  if (saving.value || loading.value) return;
  // Shared presets never hold keys; checked here so the user gets a translated message, not a server 400.
  baseUrlError.value = Boolean(currentPreset.value?.baseUrl && presetBaseUrlCarriesCredentials(currentPreset.value.baseUrl));
  if (baseUrlError.value) return;
  let category: SessionCategory;
  saving.value = true;
  try {
    if (props.mode === "create") {
      nameError.value = validateCategoryName(name.value, props.existingNames);
      if (nameError.value) return;
      try {
        category = await createSessionCategoryWithPreset(normalizeCategoryName(name.value), currentPreset.value);
      } catch (error: any) {
        if (error?.status === 409) {
          nameError.value = "duplicate";
          return;
        }
        throw error;
      }
      message.success(t("chat.categoryCreated", { name: category.name }));
    } else {
      if (!props.category) return;
      category = await updateSessionCategoryPreset(props.category.id, currentPreset.value);
      message.success(t("chat.categoryPresetSaved"));
    }
    emit("saved", category);
    show.value = false;
  } catch (error: any) {
    message.error(saveErrorText(error));
  } finally {
    saving.value = false;
  }
}

async function clearPreset() {
  if (props.mode === "create" || !props.category) {
    resetFromPreset(null);
    return;
  }
  saving.value = true;
  try {
    const category = await updateSessionCategoryPreset(props.category.id, null);
    message.success(t("chat.categoryPresetCleared"));
    emit("saved", category);
    show.value = false;
  } catch (error: any) {
    message.error(saveErrorText(error));
  } finally {
    saving.value = false;
  }
}
</script>


<template>
  <NModal
    v-model:show="show"
    preset="card"
    class="category-preset-modal"
    :title="title"
    :style="{ width: 'min(480px, calc(100vw - 32px))' }"
    :mask-closable="!saving"
    :close-on-esc="!saving"
    :closable="!saving"
    data-testid="category-preset-modal"
  >
    <form class="category-preset-form" @submit.prevent="save">
      <label v-if="mode === 'create'" class="category-preset-field">
        <span class="category-preset-label">{{ t("chat.categoryName") }}</span>
        <NInput
          v-model:value="name"
          :placeholder="t('chat.enterCategoryName')"
          :maxlength="CATEGORY_NAME_MAX_LENGTH"
          :status="nameError ? 'error' : undefined"
          :input-props="{ 'aria-label': t('chat.categoryName') }"
          data-testid="category-preset-name"
          :disabled="saving"
          @update:value="nameError = null"
        />
        <span v-if="nameErrorText" class="category-preset-error" role="alert">{{ nameErrorText }}</span>
      </label>

      <template v-if="editsPreset">
        <p class="category-preset-hint">{{ t("chat.categoryPresetHint") }}</p>

        <label class="category-preset-field">
          <span class="category-preset-label">{{ t("chat.agent") }}</span>
          <NSelect
            :value="agent"
            :options="agentOptions"
            :disabled="saving"
            data-testid="category-preset-agent"
            @update:value="handleAgentChange"
          />
          <span v-if="warningFor('agent')" class="category-preset-warning">{{ warningFor("agent") }}</span>
        </label>

        <label v-if="effectiveAgent === 'dsh'" class="category-preset-field">
          <span class="category-preset-label">{{ t("dshPresets.sessionMode") }}</span>
          <NSelect v-model:value="agentPreset" :options="dshPresetOptions" :disabled="saving" />
          <span v-if="warningFor('agentPreset')" class="category-preset-warning">{{ warningFor("agentPreset") }}</span>
        </label>

        <label v-if="hasLaunchModeChoice(effectiveAgent)" class="category-preset-field">
          <span class="category-preset-label">{{ t("codingAgents.launchModeScope") }}</span>
          <NRadioGroup v-model:value="agentMode" name="category-preset-agent-mode" :disabled="saving">
            <NRadioButton v-for="option in agentModeOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </NRadioButton>
          </NRadioGroup>
        </label>

        <label class="category-preset-field">
          <span class="category-preset-label">{{ t("sidebar.profiles") }}</span>
          <NSelect
            :value="profile"
            :options="profileOptions"
            :loading="loading || profilesStore.loading"
            :disabled="saving"
            data-testid="category-preset-profile"
            @update:value="handleProfileChange"
          />
          <span v-if="warningFor('profile')" class="category-preset-warning">{{ warningFor("profile") }}</span>
        </label>

        <label v-if="showProviderModel && showModelKind" class="category-preset-field">
          <span class="category-preset-label">{{ t("chat.modelType") }}</span>
          <NRadioGroup :value="modelKind" name="category-preset-model-kind" :disabled="saving" @update:value="handleModelKindChange">
            <NRadioButton value="model">{{ t("chat.standardModels") }}</NRadioButton>
            <NRadioButton value="moa">{{ t("chat.moaPresets") }}</NRadioButton>
          </NRadioGroup>
          <span v-if="warningFor('modelKind')" class="category-preset-warning">{{ warningFor("modelKind") }}</span>
        </label>

        <label v-if="showProviderModel && modelKind === 'model'" class="category-preset-field">
          <span class="category-preset-label">{{ t("models.provider") }}</span>
          <NSelect
            :value="provider"
            :options="providerOptions"
            :disabled="saving"
            filterable
            data-testid="category-preset-provider"
            @update:value="handleProviderChange"
          />
          <span v-if="warningFor('provider')" class="category-preset-warning">{{ warningFor("provider") }}</span>
        </label>

        <label v-if="showProviderModel" class="category-preset-field">
          <span class="category-preset-label">{{ modelKind === "moa" ? t("chat.moaPresets") : t("models.models") }}</span>
          <NSelect
            v-model:value="model"
            :options="modelOptions"
            :disabled="saving || (modelKind === 'model' && !provider)"
            filterable
            data-testid="category-preset-model"
          />
          <span v-if="warningFor('model')" class="category-preset-warning">{{ warningFor("model") }}</span>
        </label>

        <label v-if="isScopedCodingAgent" class="category-preset-field">
          <span class="category-preset-label">{{ t("codingAgents.protocolScope") }}</span>
          <NSelect v-model:value="apiMode" :options="apiModeOptions" :disabled="saving" />
          <span v-if="warningFor('apiMode')" class="category-preset-warning">{{ warningFor("apiMode") }}</span>
        </label>

        <label v-if="showBaseUrl" class="category-preset-field">
          <span class="category-preset-label">{{ t("models.baseUrl") }}</span>
          <NInput
            v-model:value="baseUrl"
            :placeholder="t('models.baseUrlPlaceholder')"
            :status="baseUrlError ? 'error' : undefined"
            :disabled="saving"
            data-testid="category-preset-base-url"
            @update:value="baseUrlError = false"
          />
          <span v-if="baseUrlError" class="category-preset-error" role="alert" data-testid="category-preset-base-url-error">
            {{ t("chat.categoryPresetBaseUrlCredentials") }}
          </span>
        </label>
        <span v-if="warningFor('baseUrl')" class="category-preset-warning" data-testid="category-preset-base-url-warning">{{ warningFor("baseUrl") }}</span>

        <div class="category-preset-field">
          <span class="category-preset-label">{{ t("chat.workspace") }}</span>
          <NAlert v-if="warningFor('workspace')" type="warning" :show-icon="false" class="category-preset-alert">
            {{ warningFor("workspace") }}
          </NAlert>
          <FolderPicker v-model="workspace" />
        </div>
      </template>
    </form>

    <template #footer>
      <div class="category-preset-actions">
        <NButton
          v-if="editsPreset"
          quaternary
          type="error"
          :disabled="saving || (mode === 'edit' && !storedPreset)"
          data-testid="category-preset-clear"
          @click="clearPreset"
        >
          {{ t("chat.clearCategoryPreset") }}
        </NButton>
        <span class="category-preset-actions-spacer" />
        <NButton :disabled="saving" @click="show = false">{{ t("common.cancel") }}</NButton>
        <NButton type="primary" :loading="saving" :disabled="saving || loading" data-testid="category-preset-save" @click="save">
          {{ t("common.save") }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.category-preset-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-height: min(64vh, 640px);
  overflow-y: auto;
}

.category-preset-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.category-preset-label {
  font-size: 12px;
  color: $text-muted;
  font-weight: 500;
}

.category-preset-hint {
  margin: 0;
  font-size: 12px;
  color: $text-muted;
  line-height: 1.5;
}

.category-preset-warning {
  font-size: 12px;
  line-height: 1.4;
  color: $warning;
  overflow-wrap: anywhere;
}

.category-preset-alert {
  font-size: 12px;
  overflow-wrap: anywhere;
}

.category-preset-error {
  font-size: 12px;
  color: var(--error);
}

.category-preset-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.category-preset-actions-spacer {
  flex: 1 1 auto;
}

:deep(.folder-picker) {
  max-height: 240px;
}

:deep(.folder-tree) {
  max-height: 150px;
}
</style>
