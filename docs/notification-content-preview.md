# System notification content preview — draft

The consumer retains Studio-user/device permission routing. Preview is enabled by default when `STUDIO_PUSH_CONTENT_PREVIEW` is unset; `1` explicitly enables it, and `0` disables it and sends blank title/body for generic gateway fallback. Existing deployments explicitly configured with `0` remain opted out. Restart Studio after changing this environment value.

**Privacy change:** session titles and bounded current-reply summaries are sent through the push gateway and APNs and may appear on the lock screen according to iOS preview settings. This is not a sensitive-data filter; use `0` for deployments that must not transmit content.

Uses only the existing appEventEnvelope display fields (content for chat, preview for group), 40/160 grapheme limits, basic Markdown cleanup. No arbitrary raw error/command fallback. A visible AI reply may still contain private material; these formatting rules are NOT a sensitive-data classifier.

Known incomplete requirements:
- Gateway contract must confirm honoring title/body, empty-field fallback and end-to-end payload size enforcement. This repository does not own the APNs final serializer.
- Chat APNs now uses only current payload.output (never historical session preview), with full-text cleanup before truncation, including unclosed fenced blocks. Android/group event display formatting still needs separate full-pipeline checks.
- Consent/settings UX, per-user/device preview setting and full privacy policy are not yet implemented; the deployment-wide environment switch is not a per-user consent control.
- Real iOS and Android content/routing acceptance is not done.
- Live Activity delivery, tokens and state are separate and not part of this PR.

Validation: focused preview + existing push consumer tests, harness check, production build. See PR for current results. Do not mark ready until these missing gates are addressed.

Validation update: added consumer opt-in integration regression failed before repair; 16 focused tests now pass, harness and production build pass. Empty current output never falls back to old chat text.

Real-device acceptance on 2026-09-19 exposed two deployment gaps: the first PR3106+PR3111 LPK omitted `STUDIO_PUSH_CONTENT_PREVIEW=1`, so the gateway correctly showed generic fallback text; an untitled structured mobile session also needed safe text extraction rather than raw JSON. The follow-up adds a regression for structured titles; the replacement LPK explicitly enables the reviewed preview mode.

A second real-device acceptance exposed a completion ordering difference from the in-App banner: coding-agent `run.completed` may carry an empty `output` even though its exact assistant `message_id` has already been persisted. The system push consumer now reads only that exact assistant row when needed. It never falls back to the latest or previous assistant message, preserving turn attribution and the existing privacy boundary.
