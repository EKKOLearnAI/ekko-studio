# Native coding agents

Studio registers Qwen Code, Kimi Code, CodeBuddy, Qoder, GitHub Copilot CLI,
and ZCode as Coding-family runtimes. They are available in single chat, group
chat, and Workflow after Studio detects their CLI on the executable search path
or ZCode's bundled CLI in a standard desktop installation directory.
Their runtime, session, group, and catalog IDs are respectively `qwen`, `kimi`,
`codebuddy`, `qoder`, `copilot`, and `zcode`.

Their implementations live in separate `coding-agents/services/<id>/`
directories. Each owns its definition and scoped configuration; Qoder owns
only its definition because it is global-only and uses the shared ACP adapter.
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
| ZCode | [Official desktop application or CLI build](https://github.com/zai-org/ZCode) | `zcode --output-format stream-json -p ...` |

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

The initial catalog does not expose image prompts, native `/compact`, context
snapshots, native settings editors, or Studio skills editors for these six
agents. Text prompts can refer to files in the selected workspace. Native CLI
errors, including required authentication, surface in chat.

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
