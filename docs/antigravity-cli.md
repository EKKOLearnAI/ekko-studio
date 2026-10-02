# Antigravity CLI integration

## Supported scope

Agent ID `antigravity`, executable `agy`. The initial integration is **global-only**:
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
Playwright tests cover native settings and the global-only picker. Compilation
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
