# ZCode plugin

Independent ZCode Protocol adapter using the public Studio SDK and drivers.
The manually installed desktop CLI 0.16.9 is the verified native baseline;
Studio does not download or publish the upstream Apache-2.0 application.

Global mode preserves native account, provider, settings, skills and session
storage. Scoped mode uses host-managed Home/storage and an Anthropic model
gateway. ZCode 0.16.9 ignores ordinary API-key `modelExecution.requestAuth`;
a per-Run loopback relay therefore keeps the host gateway token in memory.
The native provider file contains a distinct, short-lived relay credential,
with mode 0600, removed after process exit and relay revocation.

Prompts and image paths travel over bounded NDJSON, avoiding Windows command
line limits and the old argv prompt attachment workaround. Exact native session
IDs are restored with `session/resume`; the adapter never selects latest history.
Completion waits for the native terminal event, idle-state barrier and clean
process exit. MCP and resource configuration remain native. Native compaction
remains unavailable through this adapter, matching the previous integration.

Without managed MCP injection, native configuration discovery is left entirely
to ZCode. With injection, native project/user definitions are merged before
managed entries; native servers with a different working directory are rejected
because this ZCode Protocol version cannot represent `cwd`. The old integration
must remain available until that capability gap and full acceptance are closed.
