---
date: 2026-08-24
pr: 2717
feature: Defer local-only session resume
impact: Newly created chats no longer request a server resume before their first run persists the session.
---

Session switching and foreground visibility resync skip resume while a session is
still client-only. The first `run.started` event marks the original session ID as
persisted, after which normal resume behavior is restored.
