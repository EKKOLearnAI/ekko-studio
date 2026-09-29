---
date: 2026-07-25
pr: pending
feature: Custom OpenAI-compatible TTS voice selection
impact: Custom TTS playback can persist and send a configured voice instead of always relying on the provider default.
---

Custom OpenAI-compatible TTS connections now expose the same voice field used by
other speech providers. Selecting the custom provider copies the stored voice
into the legacy playback state, and group-chat playback includes that voice in
the server synthesize request.

Chat text, session persistence, and message ordering are unchanged.
