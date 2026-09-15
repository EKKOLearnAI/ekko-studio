---
date: 2026-08-21
pr: 2651
feature: Bulk session archive actions
impact: Existing batch selection now supports archiving and unarchiving applicable conversations in one request with per-session failure reporting.
---

# Bulk session archive actions

- Extended the existing batch-selection flow from PR #480 with bulk archive actions in the chat sidebar.
- Added bulk archive and unarchive actions to History; only actions applicable to the selected sessions are shown.
- Added a single batch API request with per-session success and failure reporting, while preserving the existing restriction on archiving global-agent sessions.
- Made the batch-selection entry point visible as a labeled button instead of an icon-only control.
