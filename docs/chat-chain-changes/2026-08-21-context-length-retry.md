---
date: 2026-08-21
pr: 2652
feature: Retry transient context-length lookup failures
impact: A temporary context-length request failure no longer caches the 256K UI fallback as resolved model metadata for later sessions.
---

# Retry context-length lookups after transient failures

The composer still uses its existing numeric fallback while metadata is unavailable, but only successful API responses mark a profile/provider/model key as loaded. Switching sessions with the same model can therefore retry and replace the fallback with the authoritative server value.

Closes #2637.
