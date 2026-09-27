import type { AvailableModelGroup } from "@/api/hermes/system";
import type { ChatCodingAgentId, CodingAgentApiMode } from "@/api/coding-agents";
import type { SessionCategoryPreset } from "@/api/studio/sessions";
import { canScopedCodingAgentUseProvider } from "@/utils/codingAgentProviders";

export type NewChatAgentId = "hermes" | ChatCodingAgentId;
export type NewChatAgentMode = "global" | "scoped";

export const NEW_CHAT_AGENT_OPTIONS: ReadonlyArray<{ label: string; value: NewChatAgentId }> = [
  { label: "Hermes", value: "hermes" },
  { label: "Ekko", value: "ekko-agent" },
  { label: "Claude", value: "claude-code" },
  { label: "Codex", value: "codex" },
  { label: "Pi", value: "pi" },
  { label: "Grok", value: "grok" },
  { label: "OpenCode", value: "opencode" },
  { label: "DeepSeek Harness", value: "dsh" },
];

export const CODING_AGENT_API_MODE_VALUES: readonly CodingAgentApiMode[] = [
  "chat_completions",
  "codex_responses",
  "anthropic_messages",
];

/**
 * Absolute folder path as FolderPicker produces it: POSIX (`/home/me/app`),
 * Windows drive (`C:\\work`, `C:/work`) or UNC (`\\\\server\\share`). Mirrors the
 * server-side preset rule so the form can show a translated message.
 */
export function isAbsoluteWorkspacePath(value: string): boolean {
  const path = value.trim();
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

const KNOWN_AGENTS = new Set<string>(NEW_CHAT_AGENT_OPTIONS.map((option) => option.value));

export function isExternalCodingAgent(agent: NewChatAgentId): boolean {
  return agent !== "hermes" && agent !== "ekko-agent";
}

export function effectiveNewChatMode(agent: NewChatAgentId, requestedMode: NewChatAgentMode): NewChatAgentMode {
  return agent === "ekko-agent" ? "scoped" : requestedMode;
}

export function usesProviderModel(agent: NewChatAgentId, mode: NewChatAgentMode): boolean {
  return !(agent !== "hermes" && effectiveNewChatMode(agent, mode) === "global");
}

export function isNewChatProviderAllowedFor(
  group: Pick<AvailableModelGroup, "provider">,
  agent: NewChatAgentId,
  mode: NewChatAgentMode,
): boolean {
  if (group.provider === "moa") return agent === "hermes";
  if (!(agent !== "hermes" && effectiveNewChatMode(agent, mode) === "scoped")) return true;
  return canScopedCodingAgentUseProvider(agent as ChatCodingAgentId, group.provider);
}

export type CategoryPresetWarningField =
  | "agent"
  | "profile"
  | "modelKind"
  | "provider"
  | "model"
  | "agentPreset"
  | "workspace";

export interface CategoryPresetWarning {
  field: CategoryPresetWarningField;
  /** The stored preset value that can no longer be used. */
  value: string;
}

const WARNING_MESSAGE_KEYS: Record<CategoryPresetWarningField, string> = {
  agent: "chat.presetWarningAgent",
  profile: "chat.presetWarningProfile",
  modelKind: "chat.presetWarningModelKind",
  provider: "chat.presetWarningProvider",
  model: "chat.presetWarningModel",
  agentPreset: "chat.presetWarningAgentPreset",
  workspace: "chat.presetWarningWorkspace",
};

/** i18n key for a stale-value warning; the message takes `{ value }`. */
export function presetWarningMessageKey(field: CategoryPresetWarningField): string {
  return WARNING_MESSAGE_KEYS[field];
}

export interface CategoryPresetResolveContext {
  /** Drawer agent/mode before the preset is applied (today's default). */
  currentAgent: NewChatAgentId;
  currentAgentMode: NewChatAgentMode;
  /** Profiles the current user can use. */
  profiles: readonly string[];
  /** The user's default profile, used when the preset profile is unavailable. */
  defaultProfile: string;
  /** Selectable model groups for a profile/agent/mode (already filtered like the drawer). */
  selectableGroups: (profile: string, agent: NewChatAgentId, mode: NewChatAgentMode) => readonly AvailableModelGroup[];
  /** Profile default model for a profile, used to pick a fallback model inside a valid provider. */
  profileDefaultModel?: (profile: string) => string | undefined;
  /** Known DSH session preset ids; undefined when unknown (skip the check). */
  dshPresetIds?: readonly string[];
  /** Server-side workspace check; undefined when unknown. */
  workspaceExists?: boolean;
}

/**
 * Values to apply to the New Chat panel. Undefined fields keep today's default.
 * The stored preset itself is never changed.
 */
export interface ResolvedCategoryPreset {
  agent?: NewChatAgentId;
  agentMode?: NewChatAgentMode;
  profile: string;
  modelKind?: "model" | "moa";
  provider?: string;
  model?: string;
  apiMode?: CodingAgentApiMode;
  baseUrl?: string;
  agentPreset?: string;
  workspace?: string;
  warnings: CategoryPresetWarning[];
}

function fallbackModel(group: AvailableModelGroup, profileDefault?: string): string {
  return profileDefault && group.models.includes(profileDefault) ? profileDefault : group.models[0] || "";
}

export function resolveCategoryPreset(
  preset: SessionCategoryPreset | null | undefined,
  context: CategoryPresetResolveContext,
): ResolvedCategoryPreset {
  const warnings: CategoryPresetWarning[] = [];
  const result: ResolvedCategoryPreset = { profile: context.defaultProfile, warnings };
  if (!preset) return result;

  let agent = context.currentAgent;
  if (preset.agent) {
    if (KNOWN_AGENTS.has(preset.agent)) {
      agent = preset.agent as NewChatAgentId;
      result.agent = agent;
    } else {
      warnings.push({ field: "agent", value: preset.agent });
    }
  }
  let mode = context.currentAgentMode;
  if (preset.agentMode && isExternalCodingAgent(agent)) {
    mode = preset.agentMode;
    result.agentMode = mode;
  }
  const effectiveMode = effectiveNewChatMode(agent, mode);

  if (preset.profile) {
    if (context.profiles.includes(preset.profile)) {
      result.profile = preset.profile;
    } else {
      warnings.push({ field: "profile", value: preset.profile });
    }
  }
  const profile = result.profile;

  if (usesProviderModel(agent, effectiveMode)) {
    const groups = context.selectableGroups(profile, agent, effectiveMode);
    const profileDefault = context.profileDefaultModel?.(profile);
    if (preset.modelKind === "moa") {
      const moa = agent === "hermes" ? groups.find((group) => group.provider === "moa" && group.models.length > 0) : undefined;
      if (!moa) {
        warnings.push({ field: "modelKind", value: "moa" });
      } else {
        result.modelKind = "moa";
        result.provider = "moa";
        if (preset.model && !moa.models.includes(preset.model)) {
          warnings.push({ field: "model", value: preset.model });
        }
        result.model = preset.model && moa.models.includes(preset.model) ? preset.model : moa.models[0];
      }
    } else {
      const standardGroups = groups.filter((group) => group.provider !== "moa");
      if (preset.provider) {
        const group = standardGroups.find((item) => item.provider === preset.provider);
        if (!group) {
          warnings.push({ field: "provider", value: preset.provider });
          if (preset.model) warnings.push({ field: "model", value: preset.model });
        } else {
          result.modelKind = "model";
          result.provider = group.provider;
          if (preset.model && !group.models.includes(preset.model)) {
            warnings.push({ field: "model", value: preset.model });
          }
          result.model = preset.model && group.models.includes(preset.model)
            ? preset.model
            : fallbackModel(group, profileDefault);
        }
      } else if (preset.model) {
        const group = standardGroups.find((item) => item.models.includes(preset.model!));
        if (group) {
          result.modelKind = "model";
          result.provider = group.provider;
          result.model = preset.model;
        } else {
          warnings.push({ field: "model", value: preset.model });
        }
      }
    }
    if (agent !== "hermes" && effectiveMode === "scoped") {
      if (preset.apiMode && CODING_AGENT_API_MODE_VALUES.includes(preset.apiMode)) result.apiMode = preset.apiMode;
      if (preset.baseUrl) result.baseUrl = preset.baseUrl;
    }
  }

  if (agent === "dsh" && preset.agentPreset) {
    if (context.dshPresetIds && !context.dshPresetIds.includes(preset.agentPreset)) {
      warnings.push({ field: "agentPreset", value: preset.agentPreset });
    } else {
      result.agentPreset = preset.agentPreset;
    }
  }

  if (preset.workspace) {
    if (context.workspaceExists === false) {
      warnings.push({ field: "workspace", value: preset.workspace });
    } else {
      result.workspace = preset.workspace;
    }
  }

  return result;
}

export function hasCategoryPreset(preset: SessionCategoryPreset | null | undefined): boolean {
  return Boolean(preset && Object.values(preset).some((value) => value !== undefined && value !== ""));
}

/** Drops empty fields so "Default" selections are not stored. */
export function compactCategoryPreset(preset: SessionCategoryPreset): SessionCategoryPreset | null {
  const entries = Object.entries(preset).filter(([, value]) => typeof value === "string" ? value.trim() !== "" : value != null);
  if (entries.length === 0) return null;
  return Object.fromEntries(entries.map(([key, value]) => [key, typeof value === "string" ? value.trim() : value])) as SessionCategoryPreset;
}

export const CATEGORY_NAME_MAX_LENGTH = 40;

export function normalizeCategoryName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export type CategoryNameError = "required" | "tooLong" | "duplicate";

export function validateCategoryName(
  value: string,
  existingNames: readonly string[],
): CategoryNameError | null {
  const name = normalizeCategoryName(value);
  if (!name) return "required";
  if (name.length > CATEGORY_NAME_MAX_LENGTH) return "tooLong";
  const lower = name.toLocaleLowerCase();
  if (existingNames.some((existing) => existing.toLocaleLowerCase() === lower)) return "duplicate";
  return null;
}
