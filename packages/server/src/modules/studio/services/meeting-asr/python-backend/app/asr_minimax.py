"""MiniMax Speech-to-Text REST client.

The MiniMax ASR API (https://platform.minimax.cn/docs/api-reference/speech-to-text)
is HTTP-only: a `multipart/form-data` POST to `/v1/speech_to_text` with the
audio file (must be a container — `wav`, `mp3`, `opus`, `aac`, `ogg`;
raw PCM is rejected) plus the `model` field. Two modes:

  * `stream=true` returns SSE deltas via `data: <json>` lines that share an
    incrementing `index`; the consumer concatenates `delta` until a
    `finish: true` event arrives.
  * `stream=false` returns a single JSON / SRT / VTT body.

This module keeps a ParaformerProxy-style interface (`connect` / `send_audio`
/ `upstream_events` / `finish` / `close`) so the WebSocket bridge in
`main.py` can swap providers without restructuring the message pump.

Audio chunking: MiniMax caps a single request at 500s of audio and 50 MB.
We chunk the incoming Int16 mono PCM stream at
`settings.minimax_chunk_seconds` (default 12s) by buffering PCM frames
between successive `send_audio()` calls; when the buffer crosses the
window we encode it to the configured container (default WAV) and POST it.
Shorter windows trade latency for HTTP overhead.

Container encoding: MiniMax rejects raw PCM, so we wrap the buffered
little-endian Int16 PCM frames into a WAV (RIFF) header in-memory. WAV is
lossless and the cheapest to encode at runtime; if the operator picks
`mp3` / `opus` etc. we fall back to passing the bytes unchanged (the
chunked PCM-as-WAV payload is the only path we encode ourselves).
"""

from __future__ import annotations

import asyncio
import json
import logging
import struct
import uuid
from typing import Any, AsyncIterator, Iterable

import httpx

from ._log_helper import log_skip
from .config import settings

log = logging.getLogger("asr_minimax")


def _pcm_to_wav(pcm: bytes, sample_rate: int) -> bytes:
    """Wrap raw little-endian Int16 mono PCM in a minimal WAV header.

    MiniMax accepts WAV with 16-bit PCM at any of {8k, 16k, 24k, 48k} Hz
    (per the docs the format knob is the audio format itself; the API
    ignores sample_rate mismatches). 16 kHz mono matches what
    `pcm-worklet.ts` ships from the browser and is the cheapest encode
    path — no transcoding, just a 44-byte RIFF header.
    """
    if not pcm:
        return b""
    bits_per_sample = 16
    channels = 1
    byte_rate = sample_rate * channels * bits_per_sample // 8
    block_align = channels * bits_per_sample // 8
    data_size = len(pcm)
    chunk_size = 36 + data_size
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        chunk_size,
        b"WAVE",
        b"fmt ",
        16,
        1,  # PCM
        channels,
        sample_rate,
        byte_rate,
        block_align,
        bits_per_sample,
        b"data",
        data_size,
    )
    return header + pcm


class MiniMaxProxy:
    """Bridges a frontend WebSocket to the MiniMax Speech-to-Text REST API.

    Accepts the same wire shape as `ParaformerProxy` so `main.py` can route
    either proxy transparently: a `start` JSON frame followed by raw
    Int16 PCM binary frames, then a `stop` JSON frame.
    """

    def __init__(self) -> None:
        # `task_id` is preserved on the upstream side because the DashScope
        # WebSocket protocol expects it in the wire format. MiniMax has no
        # equivalent — we mint a fresh UUID so the JS UI sees the same
        # identifier shape regardless of provider.
        self.task_id: str = str(uuid.uuid4())
        self._send_lock = asyncio.Lock()
        # Bytes of PCM we've buffered but not yet flushed to the upstream
        # REST endpoint. The flush trigger is `chunk_seconds` * sample_rate * 2.
        self._buffer: bytearray = bytearray()
        # Per-session SSE / POST request bookkeeping — each chunk becomes a
        # fresh HTTP request.
        self._closed = False

    @property
    def _chunk_byte_threshold(self) -> int:
        """Bytes of Int16 mono PCM that constitute one request."""
        seconds = float(settings.minimax_chunk_seconds or 12.0)
        # Honour the MiniMax 500s hard cap — splitting at min(default, 500).
        seconds = min(seconds, 480.0)
        rate = int(settings.minimax_sample_rate or 16000)
        # Int16 mono = 2 bytes / sample.
        return max(int(rate * 2 * seconds), rate * 2)  # at least ~0.5s

    @property
    def _endpoint(self) -> str:
        base = (settings.minimax_base_url or "https://api.minimaxi.com").rstrip("/")
        return f"{base}/v1/speech_to_text"

    def _auth_headers(self) -> dict[str, str]:
        if not settings.minimax_api_key:
            raise RuntimeError("MINIMAX_API_KEY is not configured")
        return {
            "Authorization": f"Bearer {settings.minimax_api_key}",
            "User-Agent": "meeting-asr-cloud/0.1",
        }

    async def connect(self) -> None:
        """Validate credentials up front so the UI gets a fast failure.

        `MiniMaxProxy` does not hold a persistent upstream connection
        (every PCM window is its own HTTP POST). The closest analogue is
        to send a tiny probe: an empty multipart body fails fast on auth
        (HTTP 401) and on endpoint reachability (HTTP 4xx/5xx).
        """
        if not settings.minimax_api_key:
            raise RuntimeError("MINIMAX_API_KEY is not configured")
        if not settings.minimax_base_url:
            raise RuntimeError("MINIMAX_BASE_URL is not configured")
        # The `connect()` call is invoked once when the frontend WS opens;
        # we do NOT block on a probe here to keep the latency budget low.
        # Auth failures will surface from the first `_post_chunk()` instead.
        log.info(
            "minimax proxy ready: endpoint=%s model=%s chunk_seconds=%.1f",
            self._endpoint,
            settings.minimax_asr_model,
            float(settings.minimax_chunk_seconds or 12.0),
        )

    async def send_audio(self, pcm_bytes: bytes) -> None:
        """Append PCM frames to the rolling buffer; flush when full."""
        if self._closed:
            raise RuntimeError("minimax proxy is closed")
        async with self._send_lock:
            self._buffer.extend(pcm_bytes)
            if len(self._buffer) >= self._chunk_byte_threshold:
                await self._flush_locked()

    async def _flush_locked(self) -> None:
        """POST the buffered PCM as a single request and reset the buffer."""
        if not self._buffer:
            return
        chunk = bytes(self._buffer)
        self._buffer.clear()
        await self._post_chunk(chunk)

    async def _post_chunk(self, pcm: bytes) -> None:
        """Encode PCM and POST it; surface the result as an async event."""
        if not pcm:
            return
        container = (settings.minimax_audio_format or "wav").lower()
        sample_rate = int(settings.minimax_sample_rate or 16000)
        if container == "wav":
            payload = _pcm_to_wav(pcm, sample_rate)
            filename = "chunk.wav"
            content_type = "audio/wav"
        else:
            # Operators may override the container via the API surface
            # (`minimaxAudioFormat`); for anything other than `wav` we
            # treat the bytes as already-encoded and pass them through —
            # encoding to mp3/opus on the fly would pull in extra deps
            # the docs don't require.
            payload = pcm
            filename = f"chunk.{container}"
            content_type = f"audio/{container}"

        model = settings.minimax_asr_model or "asr-1.0"
        # Plain form fields must go through `data=`: httpx treats every
        # `files=` entry as a file field requiring a 2/3/4-tuple, so a
        # 1-tuple field raises "not enough values to unpack (expected 4,
        # got 1)" before the request is even sent.
        form: dict[str, Any] = {
            "model": model,
            "response_format": "json",
            "stream": "false",
        }
        if settings.minimax_language:
            form["language"] = settings.minimax_language
        files = {"file": (filename, payload, content_type)}
        headers = self._auth_headers()
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(60.0)) as client:
                resp = await client.post(
                    self._endpoint,
                    headers=headers,
                    data=form,
                    files=files,
                )
        except httpx.HTTPError as exc:
            log.warning("minimax post failed: %s", exc)
            raise

        if resp.status_code >= 400:
            # Mirror DashScope's error-event shape so the frontend
            # `ws.send_json({"type": "error", ...})` path handles both
            # providers uniformly. Body is opaque MiniMax JSON or text.
            try:
                body = resp.json()
                message = body.get("error", {}).get("message") or body.get("message") or resp.text
            except Exception:
                message = resp.text or resp.reason_phrase
            raise RuntimeError(
                f"minimax http {resp.status_code}: {message[:500] if message else 'unknown'}"
            )

        try:
            result = resp.json()
        except json.JSONDecodeError:
            raise RuntimeError(f"minimax returned non-JSON body: {resp.text[:200]}")

        text = (result.get("text") or "").strip()
        if not text:
            # Empty transcripts (silence, noise) are valid — skip them.
            log.debug("minimax chunk returned empty text (silence?)")
            return

        # Translate to the wire format `main.py` already forwards to the
        # frontend: `{type: 'final', text, begin_time, end_time}`. MiniMax
        # does not return word-level timestamps when `stream=false`, so we
        # emit a single `final` event per chunk; the LLM analysis step is
        # the only consumer that needs intra-chunk timing, and it accepts
        # chunked input natively.
        await self._emit_event(
            {
                "type": "final",
                "text": text,
                "begin_time": None,
                "end_time": None,
                "usage": result.get("usage"),
                "chunk_seconds": len(pcm) / max(sample_rate * 2, 1),
            }
        )

    async def _emit_event(self, event: dict[str, Any]) -> None:
        """Hook for `upstream_events` consumers.

        The current `main.py` pump reads from `upstream_events()` as an
        async iterator; events also need to land in `llm_service` for the
        AI analysis side. We rely on the pump to call
        `llm_service.add_transcript(text)` for final events — see the
        `main.py` glue below.
        """
        # `upstream_events` is implemented as a queue-style generator; we
        # push onto its internal buffer in `_enqueue`.
        self._enqueue(event)

    # --- minimal async-iterator plumbing ---------------------------------
    def _enqueue(self, event: dict[str, Any]) -> None:
        if not hasattr(self, "_event_queue"):
            self._event_queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        self._event_queue.put_nowait(event)

    async def upstream_events(self) -> AsyncIterator[dict[str, Any]]:
        while True:
            event = await self._event_queue.get()
            if event is None:
                return
            yield event

    async def finish(self) -> None:
        """Drain the buffer as one final request and close the upstream."""
        async with self._send_lock:
            try:
                if self._buffer:
                    await self._flush_locked()
            except Exception as exc:
                log_skip("minimax_final_flush", exc)
        self._enqueue({"type": "stopped"})

    async def close(self) -> None:
        async with self._send_lock:
            self._closed = True
            self._buffer.clear()
        self._enqueue(None)
