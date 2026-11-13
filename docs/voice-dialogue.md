# Voice Dialogue

Hermes Web UI now supports turn-based voice input inside the existing chat UI. The current design is intentionally simple: record one voice turn, transcribe it, place the transcript into the chat input for review/editing, and let the user send it with the normal Send button.

## What works today

- Voice output / TTS: assistant replies can be spoken with the existing message playback stack. Server-backed providers are supported through the Web UI backend, and browser Web Speech remains available as a local playback option.
- Voice input / STT: choose browser speech recognition when the browser supports it, or use a server-backed provider from Models → STT.
- Dialogue flow: use the mic button in chat for push-to-talk / click-to-record style turns. Start capture, stop capture, transcribe the audio, and stage the transcript in the current input box so the user can edit before sending.
- Turn-based behavior: this is a half-duplex flow. One capture turn becomes one editable draft; sending remains an explicit user action.

## Settings at a glance

- TTS settings are provider-based. Depending on the provider, you may configure items such as model, voice, speed, pitch, base URL, and authentication.
- STT settings are also provider-based. Depending on the provider, you may configure model, optional language hint, optional prompt, optional base URL, and authentication.
- Browser STT uses the browser's own speech recognition when available. Server-backed STT sends a one-shot audio upload to the backend for transcription.
- Voice provider settings live under the Models page in separate STT and TTS tabs. Existing `Settings → Voice` links redirect to the TTS tab.
- Each tab shows the selected Hermes Agent profile's existing native configuration separately from providers managed by the Web UI.

## Studio and messaging channels

Voice has two control planes:

- **Hermes native** keeps using provider blocks already present in the profile's `config.yaml`, including local providers such as Local STT, Piper, NeuTTS, and KittenTTS.
- **Ekko Studio** keeps upstream settings and secrets in Web UI storage. Hermes sees one command provider named `hermes-studio`, regardless of which upstream Web UI provider is active.

Selecting a Web UI-managed provider writes only the `hermes-studio` command provider into the active profile. Existing native provider blocks are merged and preserved. The command calls a profile-scoped loopback URL:

```text
/api/studio/voice/proxy/:profile/v1/tts
/api/studio/voice/proxy/:profile/v1/audio/transcriptions
```

Encoding the profile in the URL makes routing deterministic for simultaneous gateways. The loopback command authenticates with a Web UI-owned curl config under `HERMES_WEB_UI_HOME`; upstream provider keys are never copied to the Hermes profile or its `.env`.

The TTS command uploads the Hermes input file as `text/plain` with `curl --data-binary`. The server body parser explicitly supports text bodies so punctuation and multiline input arrive unchanged. The OpenAI-style JSON `/audio/speech` companion route remains available for clients that call HTTP providers directly.

If Browser STT is selected, Hermes stays on its native local STT because browser recognition cannot serve messaging gateways. If a selected cloud provider is missing its stored key, STT falls back to local and TTS falls back to Edge rather than writing a broken Studio provider.

## Provider support

Web UI catalog entries are backed by working server adapters:

- TTS: Edge, OpenAI-compatible, MiMo, Doubao, ElevenLabs, Gemini, xAI, Mistral, MiniMax, and DeepInfra.
- STT: Browser, OpenAI-compatible, Doubao, Groq, Mistral, xAI, ElevenLabs, and DeepInfra.

Provider-specific calls follow Hermes Agent's native contracts. For example, ElevenLabs uses `xi-api-key`, xAI uses its dedicated `/v1/tts` and `/v1/stt` endpoints, Mistral TTS decodes `audio_data`, Gemini wraps returned 24 kHz PCM as WAV, and MiniMax decodes its hex audio payload. Local model providers remain native to Hermes rather than being duplicated in the Node server.

## Barge-in and cancellation

- If assistant audio is already playing, starting a new voice capture stops that audio first.
- This barge-in boundary is about playback only. It does not silently cancel an in-flight agent run.
- Cancelling an active run remains explicit. Use the normal stop/abort controls, or another explicit cancel action exposed by the chat session.

## Security and privacy

- Provider keys are stored server-side.
- The browser only receives masked key status for configured providers.
- Raw provider secrets are not stored in localStorage.
- Captured microphone audio is one-shot: it is used for a single transcription request rather than a persistent call or background recording stream.

## Current non-goals / future work

The current Web UI voice dialogue does not yet include:

- telephony or call flows
- always-on wake-word listening
- native desktop overlays
- realtime full-duplex voice sessions with simultaneous listen/speak behavior

Those are future areas, but they are outside the current Web UI voice dialogue scope.
