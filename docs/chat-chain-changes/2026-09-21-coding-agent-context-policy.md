# Scoped coding-agent context and compaction

All six scoped coding runtimes use Studio's selected profile/provider/model to
resolve their context window. A manual `model_context` database override wins
over provider configuration, model catalog metadata, and fallback values, even
when the profile has no config.yaml yet.

The trigger ratio comes from the same normalized `compression.threshold` as
ordinary chat (default 0.5, bounded to 0.05–0.95). Coding agents always retain
native automatic compaction: `compression.enabled` controls ordinary chat only.
Summary budgets, protected message counts, and the auxiliary compression model
are not translated into native settings with different semantics.

| Runtime | Generated settings |
| --- | --- |
| Codex | `model_context_window`, `model_auto_compact_token_limit`, total-scope accounting; inherited window/threshold overrides are replaced. |
| Claude Code | `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`; automatic and manual compaction are not disabled by inherited environment flags. |
| Pi | Model context window plus `compaction.enabled`, `reserveTokens = window - trigger`, and a bounded recent-history budget. The managed provider/model override uses the same budgets. |
| Grok | Model context window and `auto_compact_threshold_percent`; the runtime environment pins the same percentage so a parent-shell override cannot win. |
| OpenCode | Model `limit.context`, `limit.input`, `limit.output`; `compaction.auto = true` and `reserved = window - trigger`. Explicit input capacity makes the V1 threshold calculation honor the reserve. |
| DSH | Routed model context window plus a final `compaction-basic` overlay with `auto = true` and `thresholdRatio`. Private settings cannot replace that overlay with stale compaction policy. |

Native safety limits still apply. Codex 0.153.4 caps the automatic trigger at
90% of its resolved context window. Claude's rolling window is bounded to
100K–1M; Studio adjusts the percentage for smaller windows and clamps it to
the native 1–100 range. Percentage-based engines have integer-percent precision.
An engine can therefore compact earlier than Studio's requested ratio when its
own supported window or trigger ceiling is lower.

Saving a manual model window invalidates that provider's managed runtimes.
Saving the profile's threshold invalidates its scoped runtimes. Idle runtimes
are released immediately; active turns finish before disposal. The next launch
regenerates settings and resumes the existing native session. Changing only
ordinary chat's compression switch does not restart coding agents. Global CLI
mode keeps its native model/configuration ownership.

Regression coverage includes all six generated configurations, regeneration
after a window/threshold change, stale inherited settings, manual database
overrides without config.yaml, profile/provider invalidation, and an installed
DSH ACP run with a local model fixture.
