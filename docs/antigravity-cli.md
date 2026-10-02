# Antigravity CLI integration

## Supported scope

Agent ID `antigravity`, executable `agy`. The integration supports **global and scoped** modes. In global mode:
model selection and authentication remain owned by the official CLI. Studio does
not install, update, uninstall, log in, or convert Google subscriptions into model
APIs. Use https://antigravity.google/docs/cli/install and run `agy` interactively
on the connected Studio host before launching headless chat. The protocol and CLI
flags were checked against official CLI **1.2.14**, downloaded to a temporary
research directory and verified against the official SHA-512 manifest.

- Shared Web/Electron UI: Agent Manager, native configuration, MCP, skills,
  chat picker, history identity, group presets, workflows and runtime notifications.
- App: companion branch in `hermes-studio-app` includes corresponding identity,
  pickers, global mode, configuration, skills and workflow skill routing.
- File paths can be included as text. Native image input is explicitly rejected.
- `/usage` and `/status` use recorded native usage; `/context` remains unknown
  because aggregate turn tokens are not a current-context snapshot.
- Native `/compact`, automatic overflow recovery, native subagent cards and
  memory export are **not supported** in this initial integration.
- Queueing/insertion, cancellation, idle disposal, workspace diff tracking and
  server shutdown use the shared coding-agent run manager.

## Native configuration and isolation

User settings: `~/.gemini/antigravity-cli/settings.json`.
User MCP: `~/.gemini/config/mcp_config.json`.
User preferences: `~/.gemini/config/AGENTS.md`.
Private skills: `~/.gemini/config/skills`; shared Studio skills: `~/.agents/skills`.

Each Studio runtime gets a shadow HOME under its own runtime directory. User
settings are copied, Studio MCP definitions are merged into a private MCP file,
and skills/native state are linked. Native authentication and session state stay
owned by the official CLI. User settings, MCP and permission files are not mutated
by launch. Studio MCP servers receive explicit `ELECTRON_RUN_AS_NODE=1` and the
current turn credential file. Only Studio's injected MCP servers are added to the
shadow permissions allow list; shell/file approval policy and deny rules remain
unchanged. Never pass `--dangerously-skip-permissions` automatically.

Google keyring authentication with shadow HOME, Windows link privileges and
native state compatibility still require real-platform acceptance testing.

## Wire protocol and lifecycle

A fresh CLI process is used per turn, with `--input-format stream-json --output-format stream-json
--print-timeout 0`; one user NDJSON event is written to UTF-8 stdin followed by EOF, not a command argument. Resumption
uses `--conversation <native-id>`, never `--continue` (which can select another
conversation). Studio persists native IDs from `init` and final `result`.

`step_update` text is incremental; tool IDs are conversation + step_index, with
repeated starts/completions suppressed. Model-step DONE is not a turn boundary.
Only terminal `result.status=SUCCESS` can complete a turn. Missing result, unknown
status and error/cancel/interruption fail closed, including when exit code is 0.
Final response text is fallback-only to avoid replaying streamed text. Final
usage is counted once; per-step usage is not added to it. Usage costs are estimates
where catalog pricing applies, not a claim about Google subscription charges.

A native SUCCESS still does not prove that every requested tool action occurred:
headless permission requests may be soft-denied. Inspect tool output and final
answer; do not present process success as a verified filesystem change.

## Verification boundaries

Unit/mocked-process tests cover stream parsing, UTF-8, result fallback, tools,
usage, terminal boundaries, missing results, schema normalization and isolation.
Playwright tests cover native settings and the global/scoped picker. Compilation
and harness checks cover the server and Web/Electron client. App Node tests cover
its source/runtime contracts, not an APK/IPA build.

No Google login, paid inference, real workspace coding turn, native keyring or
cross-platform packaging acceptance was performed. A release must additionally
verify login, two-turn restart/resume, actual MCP plan+clarify, stop during a tool,
permission denial, workspace diff, and App/server version compatibility.

## Feedback fixes

The initial LPK had a value-taking `-p` flag followed by `--output-format`; official
CLI 1.2.14 rejected it with exit 2. The adapter now uses explicit stream-json input
and sends one NDJSON user event followed by EOF. Actual CLI validation with a
clean temporary HOME reaches authentication-required rather than flag parsing
error. No authenticated inference is claimed. Antigravity is also excluded from
Studio's npm auto-update scheduler, like other manually installed native CLIs.

The test LPK bundled agy for convenience; ordinary Studio still allows manual
installation on its host. Native installation is not inherently global-only.
Current official API-key documentation accepts modelProvider=gemini and
GOOGLE_GEMINI_BASE_URL for Gemini-compatible endpoints; it does not establish
support for arbitrary Studio OpenAI/Responses/Anthropic providers. Gemini-scoped
configuration/protocol adaptation is a separate pending feature, not a proven
CLI impossibility.

## Installation policy

Antigravity is manually installed by the user, matching Cursor's installation
policy. Studio detects executable path and installed version; opening the Agent
Manager probes missing native CLIs and returning to the page (focus/visibility)
refreshes installed versions. This is installed-version detection, not an
automatic upstream-update check. No automatic installation/update/removal. Future
LPK builds must not preinstall agy; the earlier test image bundled it and is not
automatically modified by this policy change.

## Actual external endpoint probe (CLI 1.2.14)

A clean temporary HOME with modelProvider=gemini, a dummy GEMINI_API_KEY and a
loopback GOOGLE_GEMINI_BASE_URL successfully executed an NDJSON headless turn.
The actual CLI POSTed Gemini streamGenerateContent requests, emitted text and
nonzero usage, and returned SUCCESS without Google account login. A second probe
executed model → tool attempt → functionResponse → model; the synthetic list_dir
call returned native TOOL_ERROR (unknown tool), not a successful filesystem action.
The parser now handles native tool state ERROR as terminal for that tool card.

Observed endpoints included gemini-3.1-flash-lite-preview for title generation and
gemini-3.1-pro-preview for the main model. Directly passing the API ID
gemini-3.1-pro-preview to --model was rejected by CLI model selection; arbitrary
custom-model and gateway environment probes were not successful. No arbitrary
OpenAI/Responses/Anthropic protocol compatibility is established by these probes.

To use the verified native channel with the current global integration, configure
modelProvider=gemini in the native CLI settings and provide GEMINI_API_KEY plus
GOOGLE_GEMINI_BASE_URL to the Studio service environment. An export in a separate
terminal is not inherited by the running service. No real key/service configuration
was changed during this probe. Scoped UI provider selection, mapping every
auxiliary request to a selected upstream model, and protocol conversion remain
pending; the mock result is not production external-provider acceptance.

## Scoped Studio Provider integration

Scoped launches now use Studio's existing Provider/model/API-mode selection and
credential policy. The native CLI receives a per-run proxy token, not the upstream
key, and modelProvider=gemini in its shadow configuration. Native account state is
not linked for scoped execution. A protected Gemini endpoint uses the existing
Responses adapters to call Chat Completions, Responses or Anthropic Messages. Both
main and auxiliary/title requests are pinned to the selected Studio model.

Initial bridge behavior buffers each provider response (stream=false upstream)
and emits one Gemini SSE chunk. Thus token-by-token upstream streaming is not
implemented yet. Provider accounting is owned by the proxy; CLI stdout exclusively
owns tool cards and turn completion. Images remain unsupported. OAuth/plan
providers retain the same scoped restrictions as other external coding agents.

Actual agy 1.2.14 + real Studio adapter + local OpenAI-compatible mock passed a
view_file tool read → function result → final SUCCESS cycle without account login.
Selected-model routing covered title and main calls. This validates the CLI/bridge
path, not Axonhub paid inference, all models, restart/resume or mobile binaries.

## Interactive permission probe (pending integration)

Actual CLI 1.2.14 NDJSON supports user inputs, not a documented permission-reply
frame. Workspace `.agents/hooks.json` PreToolUse was confirmed to run. Returning
deny blocks a synthetic command with its supplied reason. Returning allow or
permissionOverrides does not grant headless command permission in the tested
version; writing a precise allow rule during the hook also did not refresh the
CLI permission cache for the in-flight command. Global-hook discovery did not
trigger in this isolated probe. These are observations, not universal claims.

Do not expose a success-looking Studio approval without a proven one-shot native
authorization path. Do not enable blanket skip-permissions or command(*) just to
make the hook pass. Studio/App permission integration remains outstanding. The
local probes used only a new synthetic printf command in a temporary workspace,
not a retry of the user's denied command.

## Studio approvals: precise native grant + unified approval gate

The CLI hook location is `~/.gemini/antigravity-cli/hooks.json` (not the generic
config directory in this tested CLI). Runtime-generated hooks invoke a private
local socket helper; failed connections return deny. Existing native hooks and
permission deny rules remain authoritative. No command(*) or skip-permissions
argument is generated. Native permissions must preauthorize the exact operation.

Studio uses Hermes/Ekko-compatible approval.requested/respond/resolved with
once/session/always/deny. Session memory lasts for the active runner. Always
grants are keyed by exact tool name/arguments and scoped to owner/profile/workspace
in private Studio state. They do not modify CLI permission rules. Removing that
scoped approvals file revokes remembered always grants. Invalid persistence,
timeout, child exit, cancellation and shutdown deny unresolved requests.

Actual CLI1.2.14 + loopback provider + the Studio socket gate executed a synthetic
printf command after once approval and denied it after deny approval. Unit tests
cover session/permanent scope, changed arguments, corrupt state, timeout/close.
App/Web reuse their existing four-choice approval cards; full real-device UI
interaction, Windows pipes and cancellation on a real remote task remain not run.
