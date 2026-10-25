# GitHub Copilot

Independent Studio plugin with native account and isolated Studio model modes,
standard ACP images/approvals/resume, dynamic commands and native MCP. Explicit
CLI installation pins `@github/copilot@1.0.91`; native login uses `copilot login`.
Windows requires a verified PowerShell 6 or later executable.

Scoped Claude model IDs use the Anthropic gateway and its canonical native model
name; other models use generic Chat Completions BYOK. Temporary provider tokens
stay in the process environment. Native account state is separate from scoped
settings and history.

MCP is passed through Copilot's `--additional-mcp-config @file` startup option.
The host-private file belongs to one runtime lease and is removed after the
native process has stopped, including failed and cancelled turns. Global mode
keeps the existing native account Home.

Inspection uses the ACP metadata handshake and versioned Content-Length SDK
RPC for authentication and model discovery. It never creates a native session.
Account identifiers and credentials are discarded. An authentication-dependent
model catalog is reported distinctly from an unsupported operation.

References: [configuration directory](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference),
[Skills](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills),
and the public [Copilot SDK](https://github.com/github/copilot-sdk).
Complete migration acceptance, real accounts and platform matrices are tracked
separately from plugin implementation.
