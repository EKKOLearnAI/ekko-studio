# System notification content preview — draft

The consumer retains Studio-user/device permission routing. By default it still sends blank title/body. Explicit server configuration `STUDIO_PUSH_CONTENT_PREVIEW=1` opts into display title/body transmission. Deployments accepting the lock-screen privacy tradeoff must set this environment value; otherwise the gateway intentionally renders generic fallback text.

Uses only the existing appEventEnvelope display fields (content for chat, preview for group), 40/160 grapheme limits, basic Markdown cleanup. No arbitrary raw error/command fallback. A visible AI reply may still contain private material; these formatting rules are NOT a sensitive-data classifier.

Known incomplete requirements:
- Gateway contract must confirm honoring title/body, empty-field fallback and end-to-end payload size enforcement. This repository does not own the APNs final serializer.
- Chat APNs now uses only current payload.output (never historical session preview), with full-text cleanup before truncation, including unclosed fenced blocks. Android/group event display formatting still needs separate full-pipeline checks.
- Consent/settings UX, per-user/device preview setting and full privacy policy are not yet implemented; environment opt-in is for staged integration only.
- Real iOS and Android content/routing acceptance is not done.
- Live Activity delivery, tokens and state are separate and not part of this PR.

Validation: focused preview + existing push consumer tests, harness check, production build. See PR for current results. Do not mark ready until these missing gates are addressed.

Validation update: added consumer opt-in integration regression failed before repair; 16 focused tests now pass, harness and production build pass. Empty current output never falls back to old chat text.

Real-device acceptance on 2026-09-19 exposed two deployment gaps: the first PR3106+PR3111 LPK omitted `STUDIO_PUSH_CONTENT_PREVIEW=1`, so the gateway correctly showed generic fallback text; an untitled structured mobile session also needed safe text extraction rather than raw JSON. The follow-up adds a regression for structured titles; the replacement LPK explicitly enables the reviewed preview mode.
