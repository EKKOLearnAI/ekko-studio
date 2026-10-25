# Pi

Independent plugin targeting `@earendil-works/pi-coding-agent@1.4.0`. Native RPC
owns model work, images, dialogs, commands and compaction. Runs wait for
`agent_settled`, confirmed process exit and a verified native history checkpoint.

The native extension uses Pi's public provider/MCP APIs. Model credentials stay
in the process environment. Runtime MCP and instructions use a private temporary
descriptor, removed after process cleanup. Managed entries override native and
trusted project entries without changing their files. Native Pi still decides
project trust; `approveProjectConfig` explicitly opts into project resources.
Before sending user input, the runtime checks a private nonce acknowledgement
that the managed extension actually loaded. Legacy SSE MCP servers are rejected.

Global mode retains the native account/configuration Home. Scoped mode isolates
Pi's Home and agent directory and uses the Studio Responses gateway. Both modes
store managed conversations separately. Native login starts Pi's interactive
`/login`; metadata inspection does not log in or refresh accounts.
Global usage includes separate native compaction calls; scoped usage belongs to
the host gateway. Manual compaction follows Pi's native history-retention rules
and fails explicitly when there is no older context to summarize.

Primary references: [RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md),
[MCP](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md).
Complete migration acceptance remains separate from plugin implementation.
