# Codex app-server runtime increment

`studio.agent-codex` registers the reserved `codex` type through the public SDK.
The independent bundle uses the native stdio app-server protocol, with a process
owned by the Studio runtime lease. Global mode initializes once; scoped mode
starts a fresh app-server per turn. Both start/resume the exact
native thread, and filters all output and approval requests by thread and turn.
Text snapshots replace streamed text; tool completion is deduplicated. Cancellation
requests native interruption in global mode; scoped cancellation closes the
Run-owned transport immediately. Both wait for confirmed process cleanup. The public
configuration schema preserves native defaults unless a setting is supplied.

This increment supports global and scoped text/image execution, command/file approvals, multi-question
native clarification, thread restoration and persistent turns. Choices retain their
descriptions; only questions that allow other answers accept free text. Native
request resolution withdraws unanswered Studio interactions and suppresses late
replies. Cancellation never invents an answer. Secret questions are rejected before
any prompt is persisted, pending a dedicated credential interaction channel.
It is not automatically installed and
does not replace legacy chat or management. Login/configuration
management, MCP elicitation, compaction, global native usage ledger
reconciliation and the full real CLI acceptance matrix remain incomplete. Native
cumulative counters are not represented as fabricated per-call usage records.

Protocol reference: [official app-server documentation](https://learn.chatgpt.com/docs/app-server).
The initial schema was also checked against locally generated Codex 0.163.0 types.

The optional `management.inspect` adapter uses a separate short-lived app-server
to read account state without refreshing credentials and enumerate native models
with bounded pagination. It returns no email, account identifier, native home,
configuration or token. Inspection does not start a thread or prompt, log in,
or mutate configuration. Host cancellation/grant revocation reaps its resources.

`npm run verify:plugins:native` builds both native plugin artifacts and runs two
real CLI turns in each of global and scoped modes against local model fixtures in temporary homes. Set
`STUDIO_CODEX_COMMAND` and `STUDIO_QWEN_COMMAND` when the installed CLIs are not on
PATH. This verifies global native inspection, text streaming, session reuse and scoped host accounting without account login
or remote model calls; it does not cover the complete vendor acceptance matrix.

Scoped mode requires `models.gateway` authorization, a Studio-qualified `model`
and a host-issued `runtime.stateDirectory`. It supports native Responses providers and conversion to Chat Completions or Anthropic Messages for portable text, image and function-tool requests. A fresh loopback lease binds each request to the current Run, while
upstream credentials remain in the host. Native custom tools and reasoning history
pass through unchanged. The plugin uses an isolated HOME/CODEX_HOME and persists
only the gateway URL and environment-key name, never its temporary token.

State is separated by owner, profile, instance, provider version and state revision, and retained across worker restarts of the same artifact. This is native configuration isolation,
not an OS sandbox. Old state reclamation and upgrade migration remain pending.
Scoped management inspection explicitly returns unsupported until a model-bound
management context exists; it never falls back to the global account.

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

Compatible instance updates retain the original native directory, edited resources
and committed checkpoint while advancing the configuration revision. The public
`resumeConfigKeys` capability lists the supported fields: model, prompt, reasoning
and explicit MCP settings (plus Codex approval/sandbox settings). Changing cwd,
command, arguments, environment or mode starts a fresh session. The host drains
the old runtime and commits configuration/state references atomically; stale
resource snapshots still fail. Different artifact generations/versions do not
inherit checkpoints automatically. Cross-mode migration remains pending.

The native acceptance script now uses the actual coordinator, changes compatible
configuration and reactivates the provider between turns, and checks directory,
checkpoint, image, configured MCP-tool discovery and accounting continuity. Qwen deferred tool declarations are checked through a real tool_search call, and each revision must produce a fresh native MCP tools/list request. It also switches scoped sessions
from native protocol to Chat Completions and back. Codex applies translated
web-search restrictions as thread overrides, preserving the native config file.

`management.setup` probes only `--version` through host-managed processes and
returns bounded CLI availability/version metadata plus manual installation and
login instructions. Installation examples are pinned to the native acceptance
versions; no installation or login runs automatically. Global login happens in
the native terminal with the instance's working directory and environment. Scoped
mode uses Studio credentials and returns no native login command. This probe does
not establish account authentication, run inference or create a native session.
The existing configuration page can now create/edit instances from the registered
schema and display these instructions. A super administrator may explicitly enable
this implemented bundled artifact through the trusted distribution setup endpoint;
that endpoint does not replace installed generations or default-install all agents.
