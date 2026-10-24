# Qwen Code runtime increment

The bundled `studio.agent-qwen` package registers the reserved `qwen` Agent type
through the public SDK. Build it with `node scripts/build-agent-plugins.mjs` from
the repository root; the independently loadable artifact is `dist/plugins/qwen-code`.
The bundle includes the SDK and ACP driver and does not import server code.

This increment supports global and scoped text/image turns, streamed text/reasoning/tools,
host-mediated approvals, native session restoration, cancellation and confirmed
process cleanup. Configuration requires an absolute `cwd`; optional `command`,
`args`, `env`, `model`, `reasoningEffort`, `systemPrompt` and explicit `mcpServers`
configure the native CLI. `--acp` is appended to the configured launch arguments.
In global mode, credentials are not inferred from the Studio profile. Native Qwen authentication
continues to use the CLI's configured home, including an explicitly supplied
`QWEN_HOME`. No CLI is downloaded or login performed by activation.

`management.inspect` starts a short-lived ACP connection and performs only the
v1 initialize handshake. It returns native name/version and authentication method
labels, omitting private extension fields. Current authentication remains `unknown`;
model discovery is `unsupported` without creating a session. Inspection creates
no chat history and does not authenticate or change configuration.

The artifact is not installed automatically and does not replace the existing
chat path. Cross-protocol provider conversion, host MCP/Skills injection, native management/login integration, global usage reconciliation and the full real CLI
acceptance matrix remain required before complete migration. Missing usage stays unknown.
Fixture subprocess tests do not establish compatibility with an installed vendor CLI.

Scoped mode requires `models.gateway` authorization, a Studio-qualified `model`
and host-issued `runtime.stateDirectory`. It currently supports native Anthropic
Messages providers. Each turn obtains a fresh loopback token; the host keeps the
upstream credential and accounts model calls against the exact Run. HOME, QWEN_HOME
and runtime state are isolated by owner/profile/instance/provider/config revision.
Settings contain the endpoint and environment-key name; the temporary token is
passed only in the child environment. Native history remains available for resume.
This isolates native configuration, not operating-system access; state migration
and old revision cleanup remain pending.

Scoped inspection is explicitly unsupported instead of reading the global account.
`npm run verify:plugins:native` exercises actual installed Qwen/Codex CLIs in both
modes, including two-turn continuation and scoped host accounting, using temporary
homes and local model fixtures. It does not perform account login or paid inference.

Image input uses immutable host artifacts: upload raw bytes to
`POST /api/studio/agent-images?profile=…`, then attach
`{ type: "image", artifactId: result.data.id, mediaType: result.data.mediaType }`.
The plugin requires `artifacts.read`; existing installations need the new grant.
No filesystem path or remote URL is accepted as an image reference. The host
checks owner/profile before admission and allows bounded reads only for images
in the current live Run. PNG/JPEG/WebP/single-frame GIF are accepted, up to 4 MiB
and 40 million pixels per image; a Run may attach eight images totaling 6 MiB.
Unused uploads may be deleted; accepted attachments are retained with history.

`npm run verify:plugins:native` also verifies that the second real CLI turn in
each mode forwards an image to the local model service and retains its native
session. Scoped image input requires the host model gateway to advertise vision;
gateway handles without positive image capability are rejected before native turn admission. Global
mode uses the native CLI's model configuration. This does not establish visual
understanding by a real provider or complete the remaining migration/UI work.

Scoped Qwen configuration projects the host capability to
`modelProviders.anthropic[].generationConfig.modalities.image`. For custom global
models, configure native modalities explicitly; Qwen may otherwise treat an
unknown model as text-only and replace images with a vision-bridge fallback.
