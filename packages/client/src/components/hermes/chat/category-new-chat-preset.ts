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

const SECRET_QUERY_PARAMS = new Set(["key", "api_key", "apikey", "token", "access_token", "secret", "password", "sig"]);

/**
 * True when a Base URL embeds credentials: URL userinfo (`https://user:pass@host`)
 * or a query parameter named like a secret (`?api_key=…`, case-insensitive).
 * Presets are shared, so the form refuses these with a translated message. This is
 * the one preset rule the New Chat panel does not have; it mirrors the server rule
 * (`presetBaseUrlCarriesCredentials` in session-category-preset.ts).
 */
export function presetBaseUrlCarriesCredentials(value: string): boolean {
  const raw = value.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return /^(?:[a-z][a-z0-9+.-]*:\/\/)?[^/?#]*@/i.test(raw)
      || /[?&](?:key|api[_-]?key|token|access[_-]token|secret|password|sig)=/i.test(raw);
  }
  if (url.username || url.password) return true;
  for (const name of url.searchParams.keys()) {
    if (SECRET_QUERY_PARAMS.has(name.toLowerCase().replace(/-/g, "_"))) return true;
  }
  return false;
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
  | "apiMode"
  | "baseUrl"
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
  apiMode: "chat.presetWarningApiMode",
  baseUrl: "chat.presetWarningBaseUrl",
  workspace: "chat.presetWarningWorkspace",
};

/** i18n key for a stale-value warning; the message takes `{ value }`. */
export function presetWarningMessageKey(field: CategoryPresetWarningField): string {
  return WARNING_MESSAGE_KEYS[field];
}

export interface CategoryPresetResolveContext {
  /** Drawer agent/mode before the preset is applied (today's default: the last agent used). */
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
    // The preset provider's own group, when that provider is still usable here.
    let presetProviderGroup: AvailableModelGroup | undefined;
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
          presetProviderGroup = group;
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
      // The Base URL was entered for the preset provider while it had none of its own.
      // Anywhere else (stale provider, or the provider now has its own base_url) it
      // would point another provider at the wrong endpoint, so drop it and warn.
      const baseUrlUsable = Boolean(presetProviderGroup && !presetProviderGroup.base_url);
      if (preset.baseUrl) {
        if (baseUrlUsable) result.baseUrl = preset.baseUrl;
        else warnings.push({ field: "baseUrl", value: preset.baseUrl });
      }
      // The API mode belongs to the preset provider (and to its Base URL when it had one).
      if (preset.apiMode && CODING_AGENT_API_MODE_VALUES.includes(preset.apiMode)) {
        const apiModeUsable = preset.baseUrl
          ? baseUrlUsable
          : !preset.provider || Boolean(presetProviderGroup);
        if (apiModeUsable) result.apiMode = preset.apiMode;
        else warnings.push({ field: "apiMode", value: preset.apiMode });
      }
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

/**
 * Case folding of SQLite `COLLATE NOCASE`, which the category name column uses:
 * only ASCII A-Z fold, so "Été" and "été" are different names there. The
 * server's 409 stays the source of truth; this only avoids a false "duplicate".
 */
export function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

export function validateCategoryName(
  value: string,
  existingNames: readonly string[],
): CategoryNameError | null {
  const name = normalizeCategoryName(value);
  if (!name) return "required";
  if (name.length > CATEGORY_NAME_MAX_LENGTH) return "tooLong";
  const folded = foldAsciiCase(name);
  if (existingNames.some((existing) => foldAsciiCase(existing) === folded)) return "duplicate";
  return null;
}
