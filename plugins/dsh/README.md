# DeepSeek Harness Studio plugin

Independent plugin for the native DSH Web-profile backend over ACP. It uses the public Studio SDK and protocol transport; it imports no server or client implementation.

The native install plan pins `@deepseek-ai/dsh@0.1.7-rc.2` and requires npm `--prefer-dedupe`. Native releases are checked for the preset, restoration, permission and flush integration points before writing a private adapted module. Incompatible releases fail before spawning a conversation. Original installed modules remain unchanged.

Both modes retain source Web bundles, patches, backend plugin dependencies, native settings, Skills and preset choices. Each instance owns a private ACP profile and history under host state storage. Global mode retains native model configuration; scoped mode overrides root, child and auxiliary model routes through the run-bound Responses gateway, passing its token only in the child environment. Source account and config files are not edited. Native preset identity is stored by DSH on first creation and retained on resume. Studio's previous DSH sandbox `danger-full-access` / approval `never` policy remains in effect; unexpected ACP permission requests are still bound to the owning Run and require a response.

The plugin forwards live text/reasoning and deduplicates committed ACP output by attempt/message identity. Global per-call usage includes child/auxiliary requests; scoped usage belongs to the host gateway. A successful prompt is followed by native `session/close` and a confirmed process exit before checkpoint completion. Cancellation terminates only the owned process.

Inspection runs only `--version` and returns unknown authentication and unsupported model discovery. It creates no ACP session or Run. DSH has no separate supported CLI login; configure credentials through its native Web plugin settings. Native `/compact` and SSE MCP are explicitly unsupported through this ACP integration. Streamable HTTP and stdio MCP remain available.

Native Plugins iframe, package inventory/mutation and Agent preset management remain on their existing DSH management routes. The current public management contract cannot host those native HTTP/WS/UI contributions. Resource locations describe files and do not claim management equivalence. Cross-platform, real-account and complete migration acceptance remain open.
