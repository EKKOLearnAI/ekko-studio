# OpenCode session header

Studio's Node provider requests send `x-opencode-session` to OpenCode Zen,
Go, and Free. Custom providers using an `opencode.ai` host are also detected.
Named OpenCode providers retain this behavior when configured through a proxy.

Ekko derives an opaque key from the runtime conversation context, so turns,
tool loops, retries, and background skill reviews keep the same key. Direct
model-client callers should pass `metadata.session_id` on each request in a
conversation. Requests without a session get an independent temporary scope.

Studio-managed Claude Code, Codex, Pi, Grok, and OpenCode Coding Agent requests
go through the Coding Agent proxies. They use the Studio chat session ID,
falling back to the agent session ID or registered target scope. External CLI
instances launched outside Studio do not use these proxies.

Model catalog and connection probes
have no conversation; each probe gets its own key, reused across redirects.
API authentication headers remain in place. Unrelated providers receive no
additional header.

Hermes Python requests are handled upstream. Install a Hermes runtime containing
NousResearch/hermes-agent PR #101864 (merged September 3, 2026), then restart the
runtime. This Studio change does not upgrade an installed Hermes runtime or
patch the bundled upstream source. The currently pinned August 27 source
predates that fix.
