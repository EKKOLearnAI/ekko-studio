---
date: 2026-07-27
pr: 2240
feature: Show Cost token usage on chat replies
impact: When display.show_cost is enabled, the latest completed assistant reply shows cumulative session input/output token usage.
---

The Display setting already persisted `show_cost`, but chat replies never rendered
it. MessageItem now reads the setting and surfaces the active session's
`inputTokens` / `outputTokens` on the latest completed assistant message.
