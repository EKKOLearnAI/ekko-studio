# Kimi Code

Independent Studio plugin using the public SDK and standard ACP driver. Supports global native accounts and scoped Studio models, approvals, image references, native checkpoints, MCP injection and runtime command discovery. Installs Kimi Code 2.1.1 only on explicit administrator request. Login uses the native device flow; an ACP metadata handshake does not establish account status.

Scoped model credentials are supplied through Kimi's in-memory environment override. Configuration, MCP declarations, instructions and Skills use the plugin's declared resource locations. Native account homes remain separate from scoped state. Windows requires Git Bash; an explicit `KIMI_SHELL_PATH` can select it.

Native compatibility and complete migration acceptance are recorded separately; registration is not evidence of full feature parity.

Primary references: [ACP](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html), [environment overrides](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/env-vars), [data locations](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/data-locations.html), [Skills](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills.html).
