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
owned by the official CLI. Global mode on macOS links `Library/Keychains` and
`Library/Preferences/com.apple.security.plist` into the shadow HOME so native
`security` lookups retain the login keychain. Credentials are not copied, and
external-provider mode does not add these links. User settings, MCP and permission files are not mutated
by launch. Studio MCP servers receive explicit `ELECTRON_RUN_AS_NODE=1` and the
current turn credential file. Only Studio's injected MCP servers are added to the
shadow permissions allow list; user permission files remain unchanged, but CLI permission prompts are bypassed by the launch flag. Antigravity launches use `--dangerously-skip-permissions` by explicit user-selected policy.

Windows/Linux native credential access, Windows link privileges and native state
compatibility still require real-platform acceptance testing.

## Wire protocol and lifecycle

A fresh CLI process is used per turn, with `--input-format stream-json --output-format stream-json
--print-timeout 0`; one user NDJSON event is written to UTF-8 stdin followed by EOF, not a command argument. Resumption
uses `--conversation <native-id>`, never `--continue` (which can select another
conversation). Studio persists native IDs from `init` and final `result`.

`step_update` text is incremental; tool IDs are conversation + step_index, with
repeated starts/completions suppressed. Model-step DONE is not a turn boundary.
Only terminal `result.status=SUCCESS` can complete a turn. Missing result, unknown
status and error/cancel/interruption fail closed, including when exit code is 0.
Final response text is fallback-only to avoid replaying streamed text. Global
usage sums completed model-step usage once per conversation + step_index; the
terminal result reports cumulative conversation usage on resume. Result-only
usage is a fallback for a fresh single-turn conversation. Resumed streams without
model-step usage leave the turn's usage unknown rather than recounting history.
Scoped usage continues to come from the provider proxy. Usage costs are estimates
where catalog pricing applies, not a claim about Google subscription charges.

A native SUCCESS still does not prove that every requested tool action occurred:
headless permission requests may be soft-denied. Inspect tool output and final
answer; do not present process success as a verified filesystem change.

## Verification boundaries

Unit/mocked-process tests cover stream parsing, UTF-8, result fallback, tools,
usage across resume/restart, repeated steps, terminal boundaries, missing results,
schema normalization and isolation. Playwright tests cover native settings, the
global/scoped picker and continuing unloaded search results with the same agent. Compilation
and harness checks cover the server and Web/Electron client. App Node tests cover
its source/runtime contracts, not an APK/IPA build.

Initial integration testing did not include Google login, paid inference, a real
workspace coding turn, native keyring or cross-platform packaging acceptance.
A release must additionally
verify login, two-turn restart/resume, actual MCP plan+clarify, stop during a tool,
permission denial, workspace diff, and App/server version compatibility.

On 2026-10-02, an actual macOS host reproduced authentication failure with the
shadow HOME: `security default-keychain -d user` could not find the default
keychain. Linking both native paths restored that lookup and `agy models` returned
the model list. A headless turn using native authentication reached Google but
returned HTTP 403 with a location eligibility error; model-list success does not
establish that the account can run inference. This is not cross-platform acceptance.

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

## Current permission policy (supersedes previous probe notes)

The user explicitly selected --dangerously-skip-permissions for both global and
scoped Studio launches. The Studio-specific approval hook/socket adapter has been
removed; no Studio approval card is generated by that adapter. This automatically
approves native CLI tool permissions including commands and writes, within the
process user's OS/container access. It is not an OS privilege escalation, sandbox
fix, or account/location eligibility bypass. Existing native user hooks are not
removed or disabled. User authentication/settings files are not modified.

A new build is required; existing online invocations/LPKs are not changed.
