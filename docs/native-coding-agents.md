# Native coding agents

Studio registers Qwen Code, Kimi Code, CodeBuddy, Qoder, GitHub Copilot CLI,
and ZCode as Coding-family runtimes. They are available in single chat, group
chat, and Workflow after Studio detects their CLI on the executable search path
or ZCode's bundled CLI in a standard desktop installation directory.
Their runtime, session, group, and catalog IDs are respectively `qwen`, `kimi`,
`codebuddy`, `qoder`, `copilot`, and `zcode`.

Their implementations live in separate `coding-agents/services/<id>/`
directories. Each owns its definition, scoped configuration and any environment
requirements; Qoder is global-only and uses the shared ACP adapter.
ZCode additionally owns desktop installation discovery, JSONL events and chat
turns. `services/registry/native-agents.ts` selects the configuration and turn
adapter; reusable ACP lives in `protocol/acp/`, while process lifecycle and
private-file helpers live in `services/runtime/`. These source directories do
not change the persisted `coding-agent/native/<id>/` MCP configuration paths.

Qwen Code, Kimi Code, CodeBuddy, Copilot, and ZCode support **scoped** and
**global** modes. Scoped uses the selected Studio provider/model, with isolated
per-session configuration and data under Web UI state. Global retains each
CLI's existing account and model settings and requires native CLI sign-in.

| Runtime | Scoped configuration | Client protocol |
| --- | --- | --- |
| Qwen | `QWEN_HOME`, `QWEN_RUNTIME_DIR`, modelProviders and explicit auth/model flags | Anthropic |
| Kimi | `KIMI_CODE_HOME`, documented in-memory `KIMI_MODEL_*` overrides | Anthropic |
| CodeBuddy | `CODEBUDDY_CONFIG_DIR`, private models.json alias and variant/subagent overrides | Chat Completions |
| Copilot | `COPILOT_HOME`, BYOK environment and offline mode | Anthropic for Claude; Chat Completions for other models |
| ZCode | explicit builtin/personal schemaVersion 1 files and isolated storage | Anthropic |
| Qoder | Global only; CLI BYOK uses an account-specific `/model` wizard | Native account |

The existing provider gateways translate all three Studio API modes
(Chat Completions, Responses, Anthropic Messages). Upstream credentials stay
in the server proxy; native runtime files contain only a local proxy token.
Proxy events record usage; native events own the chat/tool lifecycle to avoid
duplicate messages or premature completion. Separate native session homes
also prevent concurrent conversations from overwriting each other's models.

Copilot uses the generic OpenAI-compatible BYOK client for custom models such
as `glm-5.3-flash`. Both its agent model ID and inference wire model retain the
selected Studio ID. Claude models retain the Anthropic client. This avoids
sending custom models through Copilot's Claude-specific token estimator and
emitting its unknown Anthropic model warning into chat. The server still
translates requests to the selected upstream API mode and records upstream
usage; custom-model token estimates remain approximate.

Qoder CLI has BYOK, but its [official guide](https://docs.qoder.com/cli/custom-models)
requires the account wizard and explicitly disallows manual settings.json
configuration. Studio therefore does not advertise arbitrary scoped endpoint
injection for it.

Verified against real Qwen 0.24.7, Kimi 2.1.1, CodeBuddy 2.161.1 and
Copilot 1.0.91 ACP processes with isolated homes and a local mock model endpoint.
CodeBuddy ACP also requires `CODEBUDDY_API_KEY` at startup; it receives the
local proxy token, matching models.json, and its API base points to that proxy.
ZCode's generated builtin/personal files were validated by the official source
codecs. Real paid provider authentication is not part of these local checks.
Older native CLI releases may need updating to support these configuration APIs.

Configuration references: [Qwen model providers](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/model-providers/),
[Kimi environment overrides](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/configuration/env-vars.md),
[CodeBuddy custom models](https://www.codebuddy.ai/docs/cli/models),
[Copilot BYOK](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models),
[ZCode provider file codec](https://github.com/zai-org/ZCode/blob/main/packages/provider-node/src/provider-config-file-codec.ts).

| Runtime | Installation | Managed transport |
| --- | --- | --- |
| Qwen Code | `npm install -g @qwen-code/qwen-code` | `qwen --acp` |
| Kimi Code | `npm install -g @moonshot-ai/kimi-code` ([official guide](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html)) | `kimi acp` |
| CodeBuddy | `npm install -g @tencent-ai/codebuddy-code` | `codebuddy --acp` |
| Qoder | `npm install -g @qoder-ai/qodercli` | `qoder --acp` |
| GitHub Copilot | `npm install -g @github/copilot` | `copilot --acp` |
| ZCode | [Official desktop application or CLI build](https://zcode.z.ai/) | `zcode --output-format stream-json -p ...` |

Studio manages npm installation, updates, and removal for the five public npm
packages. ZCode requires manual installation. Studio prefers an existing
`zcode` command and otherwise detects `glm/zcode.cjs` in the desktop application:
`/Applications/ZCode.app` or `~/Applications/ZCode.app` on macOS, the standard
per-user/Program Files ZCode directories on Windows, and `/opt/ZCode` or
`/opt/zcode` on Linux. Detection, chat, and native terminal launches use the same
CLI with Studio's Node runtime (`ELECTRON_RUN_AS_NODE=1` for desktop servers).
Global desktop launches explicitly pair the app's `config/provider/zcode-builtin.json`
with the native `~/.zcode/v2/provider_config.json` (or the configured data base
directory). Scoped launches retain Studio's isolated builtin/personal files.
Custom installation directories still require a `zcode` command on PATH.
Studio does not install a similarly named third-party npm package. Native terminal
launches open the ordinary CLI rather than an ACP server.
Windows launches prefer the installed desktop entrypoint when available so
managed chat can use its safe prompt transport, even if a PATH wrapper exists.

## Platform requirements and verification

The Studio server and CLI must run in the same operating-system environment.
Windows Studio does not automatically invoke a CLI installed only inside WSL;
run both inside WSL if that is the chosen environment. Managed chat works in
headless Linux/Docker; opening an external native terminal requires a desktop
session and is unavailable inside Docker.

Windows prerequisites are checked before either scoped or global launch writes
configuration or starts a process. The check belongs to the individual Agent:

- [Kimi Code](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started.html)
  requires Git for Windows. Studio validates Git Bash in standard installation
  directories or PATH, and passes its absolute path as `KIMI_SHELL_PATH`.
  A custom `KIMI_SHELL_PATH` must point to a working native `bash.exe`;
  the Windows WSL launcher is excluded.
- [GitHub Copilot](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli)
  requires PowerShell 6 or later (`pwsh.exe`). Studio checks its version and
  includes its directory in the child PATH. Windows PowerShell 5.1 is insufficient.
- [Qoder](https://docs.qoder.com/cli/installation) does not support native Windows
  ARM64. Studio blocks installation and launch on that target before invoking npm.
  Linux ARM64 and macOS ARM64 are unaffected.
- CodeBuddy retains its upstream PowerShell fallback; missing Git Bash does not
  block it. Qwen and ZCode do not receive these other Agents' shell requirements.

A successful CLI version check still reports the CLI as installed when a runtime
prerequisite is missing, with the prerequisite error attached to its status.
Launching reports that specific error instead of attempting a broken run.

On Windows, ZCode discovery prefers `.cmd`/`.bat` over the extensionless script
that `where.exe` can also return. Its bundled desktop CJS entrypoint receives
the full prompt through stdin before running as Node's main module, preserving
long UTF-8 input, newlines and shell metacharacters. Windows launches automatically
choose the desktop bundle when available. Standalone executables and custom
command wrappers use `-p` for short prompts and the private UTF-8 attachment-file
fallback described below for large or multiline prompts.

`coding-agent-platforms.yml` runs focused checks on Windows, Linux and macOS.
Real child-process fixtures cover each Agent's supported modes, paths with spaces
and Chinese characters, long ACP prompts, the ZCode bundled prompt bridge and
process cancellation. These fixtures verify Studio's OS/process integration;
they do not authenticate with vendor services or certify every upstream CLI build.

ACP adapters negotiate protocol version 1, mount Studio MCP tools with the
current profile/run credentials, and translate assistant text, thinking, and
tool lifecycles into the existing chat event and persistence pipeline. Native
session IDs are saved; subsequent turns use advertised `session/resume` or
`session/load` support. History replay from `session/load` is discarded. Failed
or unsupported restoration reports an error instead of replacing the chat with
an empty native session. Cancellation sends `session/cancel` and uses the
existing process-group cleanup.

Supplemental ACP MCP configuration is stored under Web UI state at
`coding-agent/native/<id>/mcp.json`, separately from native CLI account settings.
Studio's managed MCP entries take precedence and disabled entries are omitted.
Every injected stdio MCP server sets `ELECTRON_RUN_AS_NODE=1` explicitly.

ZCode uses its official JSONL `model.streaming`, `tool.updated`, and `result`
events and `--resume <sessionId>` between turns. Its native MCP configuration
remains managed in ZCode; this initial integration does not expose Studio MCP
configuration for ZCode. A missing final result is a failed turn.

Image prompts use the transport supported by each CLI. ACP agents must advertise
`agentCapabilities.promptCapabilities.image` during initialization; Studio sends
base64 image blocks over stdin and reports a clear error if that capability is
missing. It never silently drops an attachment. Kimi's scoped runtime enables
`image_in`, and ZCode's scoped model rules permit native image serialization.
The selected model and provider must still accept images; a text-only model does
not gain vision from these adapters. Older CLI releases may require an update.

| Runtime | Image input | Prompt text transport |
| --- | --- | --- |
| Claude Code | Stream-json base64 blocks | stdin |
| Codex | `--image <path>` | stdin |
| Pi | RPC base64 blocks | stdin |
| Grok | JSON prompt file with base64 blocks | file |
| DSH | Negotiated ACP image blocks | stdin |
| Qwen, Kimi, CodeBuddy, Qoder, Copilot | Negotiated ACP image blocks | stdin |
| Cursor | Native `--image <path>` (available in current CLI, hidden in help) | stdin, without a positional prompt |
| OpenCode | `--file <path>` | stdin |
| ZCode | `--attach <path>` | Windows desktop bundle: stdin bridge; other launches: short argv or a UTF-8 attachment file |
| Antigravity | Native `view_file` tool, requested with uploaded absolute paths | Text-only NDJSON stdin |

Antigravity's headless NDJSON does not accept direct image blocks. Studio asks
the native viewing tool to open the uploaded image before answering; this requires
a tool-capable model and permission to read the file. The scoped Gemini bridge
preserves image bytes in both user content and `functionResponse.parts`, including
when translating to Responses, Chat Completions, or Anthropic Messages. It does
not read arbitrary local media URLs on the server. An actual CLI 1.2.14 check with
isolated state and a local mock model verified image bytes after `view_file`.

On Windows, prompt bodies no longer pass through `cmd.exe` for Cursor or
OpenCode. ACP and the other stdin/file transports likewise avoid the Windows
command-line length and newline-parsing limits. The Windows ZCode desktop bundle
receives the complete argument array, including image paths and the prompt, through
the stdin bridge before its Node entrypoint runs. Other ZCode launches keep the
argv-only `-p` interface: Studio stages multiline Windows prompts or prompts approaching the escaped
command-line limit in private files under Web UI state, passes them with
`--attach`, and instructs the agent to read through EOF because native attachment
previews can truncate. Large Unix prompts use the same fallback. Files are removed
on process exit or launch failure. Model context limits and Studio's Socket.IO
message-size limit remain independent of command-line transport.

Focused tests exercise long Chinese/emoji prompts, CRLF, shell metacharacters,
image-only turns, capability rejection, and prompt-file cleanup. Opt-in
`tests/server/native-acp-image-real.test.ts` verified Qwen 0.24.7, Kimi 2.1.1,
CodeBuddy 2.161.1, and Copilot 1.0.91 against isolated local model endpoints,
including exact image bytes and the long prompt's final sentinel. These checks
do not require real provider credentials. Windows launch cases are simulated
on non-Windows hosts; they do not substitute for a Windows machine check.

Native `/compact`, context snapshots, native settings editors, and Studio skills
editors remain unavailable for these six agents. Native CLI errors, including
required authentication and unsupported upstream image models, surface in chat.

`config/agents.json` revision `2026-10-03.4` includes their public metadata and
official product icons. Website
builds copy the first-party HTTPS icons together with the catalog. App loads
the catalog on its next process launch and also checks connected Studio runtime
availability. Publishing metadata cannot make an older Studio run a new CLI.

The icon assets come from the product owners, rather than letter placeholders:

| Runtime | Asset | Official source |
| --- | --- | --- |
| Qwen Code | `qwen-logo.svg` | [Qwen Code desktop logo](https://github.com/QwenLM/qwen-code/blob/main/packages/desktop/bootstrap/qwen-code-logo.svg) |
| Kimi Code | `kimi-logo.png` | [Kimi Code extension logo](https://github.com/MoonshotAI/kimi-code/blob/main/apps/vscode/webview-ui/public/kimi-logo.png) |
| CodeBuddy | `codebuddy-logo.svg` | [CodeBuddy website icon](https://codebuddy-1328495429.cos.accelerate.myqcloud.com/web/ide/logo.svg) |
| Qoder | `qoder-logo.svg` | [Qoder website icon](https://qoder.com/favIcon.svg) |
| GitHub Copilot | `copilot-logo.svg` | [GitHub's official Copilot Octicon](https://github.com/primer/octicons/blob/main/icons/copilot-24.svg) |
| ZCode | `zcode-logo.png` | [ZCode desktop application icon](https://github.com/zai-org/ZCode/blob/main/packages/desktop/build/icons/256x256.png) |

Copilot retains the official path geometry with neutral padding and a light
background so it remains legible in dark themes. The new filenames avoid
cached placeholder images in Studio and App. Website builds copy the same
files that Studio uses; native account and runtime behavior are unaffected.

Protocol references: [Qwen ACP](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/),
[Kimi ACP](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp),
[CodeBuddy ACP](https://www.codebuddy.ai/docs/cli/acp),
[Qoder CLI](https://docs.qoder.com/cli/cli-reference),
[Copilot CLI](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference),
[ZCode CLI source](https://github.com/zai-org/ZCode/tree/main/apps/zcode-cli/packages/cli/src).
