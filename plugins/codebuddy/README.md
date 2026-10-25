# CodeBuddy

Independent Studio plugin using the public SDK and standard ACP driver. Supports
native accounts and isolated Studio models through Chat Completions, images,
approvals, native session restoration, MCP and runtime command discovery.
Explicit CLI installation pins `@tencent-ai/codebuddy-code@2.175.0`; native login
opens the CLI's interactive authentication flow.

Scoped model aliases and temporary credentials remain separate from the user's
native account. Credentials are supplied through environment references, never
written into `models.json`. Native and workspace settings, Skills, models, MCP
and `CODEBUDDY.md` are declared as management resources. Native project trust
and override behavior continues to apply.

The ACP server can retain watchers after stdin closes. Its final result is
followed by confirmed managed process cleanup; a natural nonzero exit or failed
cleanup prevents a successful checkpoint. This policy is a generic driver
option owned by the plugin.

References: [models](https://www.codebuddy.ai/docs/cli/models),
[resources](https://www.codebuddy.ai/docs/cli/codebuddy-dir),
[Skills](https://www.codebuddy.ai/docs/cli/skills), and documentation shipped in
the pinned CLI. Full migration acceptance and real account verification are
recorded separately.
