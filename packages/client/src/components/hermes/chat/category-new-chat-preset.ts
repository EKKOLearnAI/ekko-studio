import type { AvailableModelGroup } from "@/api/hermes/system";
import type { ChatCodingAgentId, CodingAgentApiMode } from "@/api/coding-agents";
import type { SessionCategoryPreset } from "@/api/studio/sessions";
import { AGENT_OPTIONS } from "@/utils/agent-options";
import { canScopedCodingAgentUseProvider } from "@/utils/codingAgentProviders";

export type NewChatAgentId = "hermes" | ChatCodingAgentId;
export type NewChatAgentMode = "global" | "scoped";

/** The New Chat panel's agent picker, in the shared picker order (#3199). */
export const NEW_CHAT_AGENT_OPTIONS: ReadonlyArray<{ label: string; value: NewChatAgentId }> = AGENT_OPTIONS;

export const CODING_AGENT_API_MODE_VALUES: readonly CodingAgentApiMode[] = [
  "chat_completions",
  "codex_responses",
  "anthropic_messages",
];

const URL_SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:/i;
// A parameter name is secret-like when one of its words is a secret word, or the
// whole name run together is a known compound. Words split on anything but a-z0-9
// and on camelCase boundaries, so x-api-key, subscription-key, client_secret, auth,
// api_key[], signature and accessToken match, while design, author, keyspace,
// monkey, authuser, max_tokens, api-version and version do not.
const SECRET_PARAM_WORDS = new Set([
  "key", "apikey", "token", "secret", "password", "passwd", "pwd", "sig", "signature",
  "auth", "authorization", "credential", "credentials", "accesstoken", "sessiontoken",
]);
const SECRET_PARAM_COMPOUNDS = new Set([
  "apikey", "xapikey", "subscriptionkey", "clientsecret", "accesstoken", "authtoken", "sessiontoken",
]);

/** Lowercase words of a parameter name, split on non-alphanumerics and camelCase boundaries. */
function paramNameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** True when a query/fragment parameter name looks like it carries a secret. */
export function isSecretLikeParamName(name: string): boolean {
  let decoded = name;
  try {
    decoded = decodeURIComponent(name.replace(/\+/g, " "));
  } catch {
    // Malformed escapes: match the raw spelling.
  }
  const words = paramNameWords(decoded);
  return words.some((word) => SECRET_PARAM_WORDS.has(word)) || SECRET_PARAM_COMPOUNDS.has(words.join(""));
}

/** The text before the first path, query or fragment separator, after an optional scheme. */
function textualAuthorities(raw: string): string[] {
  const authority = (text: string) => text.replace(/^[/\\]+/, "").split(/[/\\?#]/, 1)[0];
  const withoutScheme = raw.replace(URL_SCHEME_PREFIX, "");
  return withoutScheme === raw ? [authority(raw)] : [authority(withoutScheme), authority(raw)];
}

/** Parameter names in the query string, read textually so no URL parser quirk hides one. */
function textualQueryParamNames(raw: string): string[] {
  const queryStart = raw.indexOf("?");
  if (queryStart < 0) return [];
  return raw.slice(queryStart + 1).split("#", 1)[0].split(/[&;]/).map((part) => part.split("=", 1)[0]);
}

/**
 * True when a Base URL embeds credentials or anything that could smuggle one:
 * a textual `@` in the authority, URL userinfo in either reading (the raw value
 * when it starts with a scheme, which WHATWG URL parses for `https:u:p@h`,
 * `https:/u:p@h`, `http:\\u:p@h`; and the `http://`-prefixed value), a query
 * parameter whose name looks secret, or any non-empty `#fragment` (never sent
 * over HTTP, so a real API Base URL has none). Presets are shared, so the form
 * refuses these with a translated message. This is the one preset rule the New
 * Chat panel does not have; it is identical to the server rule
 * (`presetBaseUrlCarriesCredentials` in session-category-preset.ts).
 */
export function presetBaseUrlCarriesCredentials(value: string): boolean {
  const raw = value.trim();
  if (!raw) return false;
  if (/#./s.test(raw)) return true;
  if (textualAuthorities(raw).some((authority) => authority.includes("@"))) return true;
  if (textualQueryParamNames(raw).some(isSecretLikeParamName)) return true;
  const readings = URL_SCHEME_PREFIX.test(raw) ? [raw, `http://${raw}`] : [`http://${raw}`];
  for (const reading of readings) {
    let url: URL;
    try {
      url = new URL(reading);
    } catch {
      continue;
    }
    if (url.username || url.password) return true;
    for (const name of url.searchParams.keys()) {
      if (isSecretLikeParamName(name)) return true;
    }
  }
  return false;
}

const KNOWN_AGENTS = new Set<string>(NEW_CHAT_AGENT_OPTIONS.map((option) => option.value));

export function isExternalCodingAgent(agent: NewChatAgentId): boolean {
  return agent !== "hermes" && agent !== "ekko-agent";
}

/** Agents whose launch mode is fixed: the panel hides the launch-mode choice and uses this mode. */
const FIXED_NEW_CHAT_MODES: Partial<Record<NewChatAgentId, NewChatAgentMode>> = {
  "ekko-agent": "scoped",
  cursor: "global",
};

export function effectiveNewChatMode(agent: NewChatAgentId, requestedMode: NewChatAgentMode): NewChatAgentMode {
  return FIXED_NEW_CHAT_MODES[agent] ?? requestedMode;
}

/** True when the panel shows the launch-mode (global/scoped) choice for this agent. */
export function hasLaunchModeChoice(agent: NewChatAgentId): boolean {
  return isExternalCodingAgent(agent) && FIXED_NEW_CHAT_MODES[agent] === undefined;
}

/**
 * True when the panel can use a Base URL for this agent/mode: a scoped coding agent.
 * The panel shows its Base URL field in that case while the selected provider has
 * no base_url of its own. Global agents (Cursor, or claude-code in global mode) and
 * Hermes never use one.
 */
export function usesBaseUrl(agent: NewChatAgentId, mode: NewChatAgentMode): boolean {
  return agent !== "hermes" && effectiveNewChatMode(agent, mode) === "scoped";
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
  /** The server dropped the stored Base URL (and its API mode) on read (`preset_status.base_url_dropped`). */
  storedBaseUrlDropped?: boolean;
}

/** Stands in for a dropped stored Base URL in its warning; the server never sends the value. */
export const DROPPED_BASE_URL_PLACEHOLDER = "…";

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

  let agent = context.currentAgent;
  if (preset?.agent) {
    if (KNOWN_AGENTS.has(preset.agent)) {
      agent = preset.agent as NewChatAgentId;
      result.agent = agent;
    } else {
      warnings.push({ field: "agent", value: preset.agent });
    }
  }
  let mode = context.currentAgentMode;
  // Like the panel, an agent with a fixed mode (Cursor: global) ignores a stored launch mode.
  if (preset?.agentMode && hasLaunchModeChoice(agent)) {
    mode = preset.agentMode;
    result.agentMode = mode;
  }
  const effectiveMode = effectiveNewChatMode(agent, mode);
  // Stale like any unusable value: the stored Base URL is gone, unless a new one replaces it.
  // Only an agent/mode that uses a Base URL warns; the others have no Base URL field.
  if (context.storedBaseUrlDropped && !preset?.baseUrl && usesBaseUrl(agent, effectiveMode)) {
    warnings.push({ field: "baseUrl", value: DROPPED_BASE_URL_PLACEHOLDER });
  }
  if (!preset) return result;

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
          result.modelKind = "model";
          result.provider = group.provider;
          if (preset.model && !group.models.includes(preset.model)) {
            warnings.push({ field: "model", value: preset.model });
          }
          result.model = preset.model && group.models.includes(preset.model)
            ? preset.model
            : fallbackModel(group, profileDefault);
          // Only a provider the panel will actually select (it needs a model) owns the
          // preset Base URL / API mode; a provider with no models is not applied.
          if (result.provider === preset.provider && result.model) presetProviderGroup = group;
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
    if (usesBaseUrl(agent, effectiveMode)) {
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
