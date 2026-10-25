# OpenCode

Independent Studio plugin using the native `opencode acp` protocol. Explicit
installation pins `opencode-ai@1.19.4` and its native executable; login runs
`opencode auth login`. Inspection only performs the metadata handshake and does
not infer account state or create a conversation.

Global mode retains the native account, configuration layers and resources.
Scoped mode isolates native configuration, data, cache and history and uses a
Chat Completions gateway through the bundled OpenAI-compatible provider.
Temporary API credentials stay in the environment; native settings are loaded
without rewriting them. ACP owns images, MCP, approvals, restoration and command
discovery. Complete migration acceptance and real accounts remain separate.
Version 1.19.4 does not advertise a native compact/compress command through ACP;
the plugin only contributes commands it actually discovers.

Primary references: [ACP](https://opencode.ai/docs/acp/),
[configuration](https://opencode.ai/docs/config/),
[Skills](https://opencode.ai/docs/skills/),
[providers](https://opencode.ai/docs/providers/).
