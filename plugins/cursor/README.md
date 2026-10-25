# Cursor system plugin

Independent public SDK/driver adapter for the native Cursor account CLI. Global mode only; scoped Studio model routing is unsupported. Cursor's endpoint speaks its own service protocol, so a Studio model token is never passed as a Cursor API key.

Verified upstream artifact: `2026.10.22-27dcf5f`. Installation remains manual using the [official installation instructions](https://cursor.com/docs/cli/installation); the unrelated npm package name is not used as an install plan. Login uses native `agent login`. Updates remain the user's native installation policy.

Each turn uses managed `agent -p --force --output-format stream-json --stream-partial-output`, stdin for prompts, exact `--resume` for checkpoints and native `--image` attachments. Native Home/account, configuration, rules, commands and Skills remain Cursor-owned. Managed MCP definitions use an ephemeral local plugin; native user/project MCP layers are untouched. Print mode has no interactive approval or clarification bridge, and no native `/compact`; those capabilities are not advertised. Runtime command discovery is unsupported in the print protocol.

Success requires native result, exit zero and completed resource cleanup. Partial assistant flushes, repeated tool events and identical terminal results do not duplicate output or usage. Input totals include disjoint cache read/write counts once; absent usage stays unknown.

Even a version check initializes native configuration. Management probes therefore use disposable isolated Home/config/cache and no Cursor credentials. Inspection returns authentication `unknown` and models `unsupported`; it creates no account conversation or Studio Run and leaves the account's files unchanged. Actual-account inference, images, Skills and MCP execution still require account acceptance; fixture coverage does not close migration acceptance.
