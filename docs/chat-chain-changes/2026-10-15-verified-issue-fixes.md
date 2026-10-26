---
date: 2026-10-15
feature: Verified issue backlog fixes
impact: Preserve configured model settings, enforce media and lockout privileges, and prevent automatic wakeups and ambiguous workspace attribution after run lifecycle changes.
---

# Verified issue fixes

This change addresses #3319, #3057, #3086, #3347, #3349, #3143, #3239,
#3342, #3293, #2993, #2404, #2751, #2759, #2637, #3382 and #3275,
and completes the redundant token-estimation path reported in #3291.

## Runtime boundaries

- Stop consumes queued automatic wake claims rather than releasing them back
  into the delivery queue. Late automatic completions remain suppressed until
  a new user run. Explicitly queued user messages retain their existing behavior.
- Hermes process cleanup is scoped to the stopped session. Pending tool-batch
  boundary requests can be recalled only for the matching current run; a boundary
  already reached or a model request already cancelled reports too late.
- Passive worker polling does not refresh the idle clock. Active requests,
  foreground turns, background work and pending notifications protect workers
  from idle collection.
- `/plan` uses the Hermes native prompt builder; runtimes without it return an
  upgrade explanation. Planning does not execute code or create a second session.

## File and credential boundaries

- Only super admins and trusted server-token callers can specify a media output
  path. Other callers can still generate into Studio-managed media storage.
  Unauthorized paths are rejected before a provider is called.
- Root OAuth grants are resolved through the same read-only credential-selection
  rules as the runtime. No refresh, token copying or root API-key inheritance is
  introduced by model discovery.
- Directory snapshots do not identify the writer when different sessions overlap
  in one workspace. Such runs no longer publish an attributed change card or its
  undo controls. Sequential runs and distinct workspaces retain their summaries.
  Writer-aware concurrent attribution would require runtime write provenance.

## Chat display

Text-channel XML tool protocol is filtered, never executed. The same filter
covers streaming replies and already-stored messages at render time, including
unfinished blocks and orphan closing tags. Fenced code and inline discussion
remain visible. Existing persisted rows are not rewritten.

Bare filenames no longer become external domain links. Explicit URLs, email
addresses and explicit Markdown links remain supported; bare domains without a
scheme are also no longer auto-linked.

## Validation

Focused regressions cover real controllers against temporary config files,
privileged route guards, Python worker lifecycle contracts, queue races,
workspace snapshots, provider URL construction and Markdown rendering.
The browser regression exercises protocol and filename rendering through the
chat UI with mocked HTTP and Socket.IO transports. Full validation results
are recorded in the pull request rather than embedding changing totals here.
