# System notification content preview — draft

The consumer retains Studio-user/device permission routing. By default it still sends blank title/body. Explicit server configuration `STUDIO_PUSH_CONTENT_PREVIEW=1` opts into display title/body transmission. This temporary integration gate is not a finished end-user preference UI and must not be silently enabled on deployment.

Uses only the existing appEventEnvelope display fields (content for chat, preview for group), 40/160 grapheme limits, basic Markdown cleanup. No arbitrary raw error/command fallback. A visible AI reply may still contain private material; these formatting rules are NOT a sensitive-data classifier.

Known incomplete requirements:
- Gateway contract must confirm honoring title/body, empty-field fallback and end-to-end payload size enforcement. This repository does not own the APNs final serializer.
- Current event display may use existing historical preview fallback upstream; eliminating previous-message fallback and truncation before Markdown cleanup requires separate event-level tests.
- Consent/settings UX, per-user/device preview setting and full privacy policy are not yet implemented; environment opt-in is for staged integration only.
- Real iOS and Android content/routing acceptance is not done.
- Live Activity delivery, tokens and state are separate and not part of this PR.

Validation: focused preview + existing push consumer tests, harness check, production build. See PR for current results. Do not mark ready until these missing gates are addressed.
