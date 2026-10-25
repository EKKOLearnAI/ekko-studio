# Antigravity Studio plugin

Independent public SDK runtime for the manually installed `agy` CLI. Native
stream-json launches retain the existing user-selected
`--dangerously-skip-permissions` policy; no synthetic approval dialog is added.
Install/login remain native operations, with the official installation link.
Metadata inspection runs only the bounded version probe, never a conversation.

Global runs copy settings/MCP/instructions into a private shadow HOME and link
native state and macOS keychain paths without copying credentials. Scoped runs
use the instance's managed native HOME with no native account links. Edited native
settings and MCP persist; Studio's per-turn MCP entries are layered privately.

Scoped Gemini requests pass through an authenticated, bounded loopback adapter to
Studio's Run-bound public Responses gateway. Studio owns upstream credentials,
selected-model routing and accounting. The adapter buffers a completed response;
unsupported Gemini semantics are rejected. Images use private temporary files
and an instruction to the native `view_file` tool, matching the existing host
integration; this is not a native stream-json image block.

Exact conversation IDs restore native history. Model-step DONE is not completion:
a SUCCESS result, confirmed zero exit and completed gateway accounting are all
required. Global step usage is deduplicated; cumulative resumed result usage is
never charged again. Cancellation, errors and malformed streams fail closed.
Native compaction, slash command discovery and interactive permissions remain
unsupported. Real accounts, native keyrings on other platforms and distribution
acceptance remain separate work.
