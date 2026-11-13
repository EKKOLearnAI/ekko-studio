"""
DashScope Omni-Realtime proxy, driven by the official Qwen Omni SDK.

Bridges a frontend WebSocket and the Aliyun DashScope real-time multimodal
endpoint that powers the Qwen-Omni-Realtime model family. The default target
is ``qwen3.8-omni-flash-realtime`` (DashScope model id) which the SDK ships
in ``dashscope.audio.qwen_omni.OmniRealtimeConversation``.

  * ``qwen3.8-omni-flash-realtime`` (default, fastest)
  * ``qwen3.8-omni-plus-realtime``  (smarter, larger context window)
  * Older Qwen-Omni-Realtime families — set ``OMNI_REALTIME_MODEL`` to the
    model id you want; the proxy drives whatever the SDK accepts, but only
    qwen3.8 has been validated against the operator presets shipped here.

The wire protocol the SDK speaks is OpenAI-Realtime-API compatible; the
upstream URL is ``wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=<name>``
(or the region-specific ``{WorkspaceId}.cn-beijing.maas.aliyuncs.com``
variant). Authentication uses the same DASHSCOPE_API_KEY as the rest of the
meeting ASR service — we deliberately *do not* expose a per-session key from
the client.

Thread / asyncio bridging
------------------------

The SDK is built on top of the synchronous ``websocket-client`` library:
``OmniRealtimeConversation`` runs its ``WebSocketApp`` on a daemon thread
and delivers each event through ``OmniRealtimeCallback.on_event(message)``.
FastAPI, by contrast, drives this proxy from an asyncio event loop.

We bridge the two via an :class:`asyncio.Queue`:

  * The SDK callback runs on the WebSocket thread; it forwards every parsed
    event into the queue with ``loop.call_soon_threadsafe``.
  * :meth:`OmniRealtimeProxy.upstream_events` is the asyncio consumer: it
    pulls items off the queue, observes response / buffer lifecycle state,
    and yields the original JSON strings to the FastAPI ``pump_upstream``
    task (which then runs ``translate_event``).

A sentinel (``_STOP_SENTINEL``) pushed by ``on_close`` or by our own
:meth:`OmniRealtimeProxy.close` makes the upstream iterator return.

Frontend protocol (binary in, JSON events out — unchanged from the previous
hand-rolled proxy):

  Frame 1 (text, required): control JSON
      {"type": "start", "voice": "Tina", "instructions": "...", "model": "...",
       "tools": [{"type": "function", "name": "...", "description": "...",
                  "parameters": {...}}, ...]}
    `model` / `voice` / `instructions` / `tools` are optional; the server-side
    config.py defaults apply otherwise. The SDK's ``update_session`` is called
    immediately after the upstream handshake with these values so the user
    can switch persona / voice per session without restarting the backend.
    When `tools` is provided the session is configured with
    ``tool_choice: "auto"`` and the model may emit function calls that are
    relayed to the client.

  Subsequent frames (binary): raw PCM16 mono little-endian Int16 samples,
    exactly what the upstream API expects in ``input_audio_buffer.append``
    payloads (we re-encode to base64 here before forwarding via
    ``OmniRealtimeConversation.append_audio``). The bridge resamples browser
    mic input to 16 kHz on input and the upstream emits 24 kHz on output by
    default, matching the SDK's ``AudioFormat.PCM_16000HZ_MONO_16BIT`` /
    ``AudioFormat.PCM_24000HZ_MONO_16BIT`` enum values.

  Text frames (JSON): control frames the frontend can send at any time:
      {"type": "cancel"} — abort the current in-flight response
      {"type": "ping"}   — heartbeat (echoed back as {"type": "pong"})
      {"type": "tool_result", "call_id": "...", "output": "..."}
                           — client-side function-call result; forwarded
                             upstream as ``conversation.item.create``
                             (function_call_output) followed by
                             ``response.create`` so the model continues.
      {"type": "image", "image": "<base64 JPEG>"}
                           — one camera frame (data URL or raw base64);
                             forwarded upstream as ``input_image_buffer.append``.
                             DashScope constraints: JPG/JPEG only, ≤256 KB
                             base64, ~1 fps recommended, and audio must be
                             appended before image data — enforced locally
                             (see ``_audio_seen`` / ``_audio_appended_since_commit``
                             below).
      {"type": "text", "text": "<prompt>"}
                           — inject a text-only user message (conversation
                             item) and ask the model to reply *within the same
                             session* (reuses the multimodal context it already
                             saw/heard). Used by 口语对练's same-session closing
                             review.
      {"type": "stop"}   — flush audio buffer and close the session
                             (we send ``session.finish`` upstream before
                             tearing the WS down).

Server → frontend frames (also unchanged):

  Binary frames: raw PCM16 mono (delta chunks from upstream
    ``response.audio.delta`` events, concatenated and forwarded as soon as
    they arrive).

  Text frames (JSON): ``ready`` / ``listening`` / ``speech_stopped`` /
    ``user_transcript`` / ``transcript_delta`` / ``transcript`` /
    ``response_started`` / ``response_done`` / ``error`` / ``stopped`` /
    ``pong``. The translator in :func:`translate_event` does the protocol
    mapping.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import uuid
from typing import Any, AsyncIterator
import websocket

# DashScope SDK — provides the high-level conversation wrapper that drives
# the OpenAI-Realtime WS on a background thread, plus the AudioFormat /
# MultiModality enums the session config requires.
from dashscope.audio.qwen_omni import (
    AudioFormat,
    MultiModality,
    OmniRealtimeCallback,
    OmniRealtimeConversation,
)

from .config import settings
from ._log_helper import log_skip

log = logging.getLogger("omni_realtime_proxy")


# Output is fixed at 24 kHz / 16-bit / mono — that's the rate DashScope sends
# the audio delta frames at. Input sample rate is also 16 kHz to match the
# SDK's `AudioFormat.PCM_16000HZ_MONO_16BIT` enum (the SDK does not accept
# 48 kHz on input). Documenting both as module constants so client + server
# stay in lock-step without a separate handshake.
OUTPUT_SAMPLE_RATE = 24000
INPUT_SAMPLE_RATE = 16000
BITS_PER_SAMPLE = 16
CHANNELS = 1

# JSON object `arguments` == "no arguments were supplied".
EMPTY_ARGUMENTS = ("", "{}")

# Pushed by the SDK callback (``on_close``) or by ``OmniRealtimeProxy.close`` to
# make the upstream iterator return. Sentinel object identity matters — must
# not collide with a real JSON event (which is always a ``str``).
_STOP_SENTINEL: object = object()


def diagnose_realtime_handshake(url: str, api_key: str, workspace: str | None = None) -> str | None:
    """Recover an actionable HTTP rejection hidden by the SDK's 5 s timeout.

    Only called after the SDK handshake fails, so successful sessions pay no
    extra connection cost. Never include the credential or response headers in
    the returned text.
    """
    headers = {"Authorization": f"Bearer {api_key}"}
    if workspace:
        headers["X-DashScope-WorkSpace"] = workspace
    try:
        probe = websocket.create_connection(url, header=headers, timeout=3)
        probe.close()
    except websocket.WebSocketBadStatusException as exc:
        status = getattr(exc, "status_code", 0)
        try:
            body = json.loads(exc.resp_body or b"{}")
        except (TypeError, ValueError):
            body = {}
        code = str(body.get("code") or "")[:64]
        detail = str(body.get("message") or "")[:120]
        if status == 401 and code == "InvalidApiKey":
            return "DashScope API key is blocked" if "blocked" in detail.lower() else "DashScope API key is invalid"
        return f"DashScope realtime rejected connection (HTTP {status}{f' {code}' if code else ''})"
    except Exception:
        return None
    return None


def _as_arguments_json(value: object) -> str:
    """Normalize an upstream tool-call ``arguments`` payload to a JSON string.

    The OpenAI-Realtime wire shape carries ``arguments`` as a JSON *string*,
    but DashScope's Omni-Realtime implementation has been observed to hand it
    out as an already-parsed JSON object instead. The frontend contract
    (``omni_realtime_proxy`` client in ``useOmniRealtime.ts``) treats any
    non-string ``arguments`` as ``{}`` and would therefore execute a
    perfectly-formed tool call with *empty* arguments — the model then sees
    ``{"error": "question 必填"}`` for a call it believes carried the question
    and retries the same call forever (the ``query_hermes_agent {}`` storm).

    Normalize here so downstream never has to guess:
      * str            → trimmed, ``"{}"`` when blank
      * dict / list    → ``json.dumps`` (ensure_ascii=False keeps CJK intact)
      * anything else  → ``"{}"``
    """
    if isinstance(value, str):
        return value.strip() or "{}"
    if isinstance(value, (dict, list)):
        try:
            return json.dumps(value, ensure_ascii=False)
        except (TypeError, ValueError):
            return "{}"
    return "{}"


def _has_arguments(arguments: str) -> bool:
    """True when a normalized arguments string actually carries parameters."""
    return arguments.strip() not in EMPTY_ARGUMENTS


class FunctionCallGate:
    """Arbitrate which ``function_call`` announcements reach the client.

    DashScope announces one model tool call up to twice — once via
    ``conversation.item.created`` (protocol bookkeeping) and once via
    ``response.function_call_arguments.done`` (the canonical, arguments-bearing
    copy). The bookkeeping copy can arrive FIRST with empty ``arguments``
    (the model is still filling them in). Forwarding that empty copy and then
    discarding the ``.done`` copy as a "duplicate" makes the client execute the
    tool with ``{}`` — and when the tool requires an argument (``question``),
    the client errors and the model retries the exact same call in a loop.

    Strategy (per call_id):
      * announcement WITH arguments  → forward immediately, remember it sent;
      * announcement WITHOUT args    → park it; a later richer copy for the
        same call_id supersedes and is forwarded; otherwise the response
        boundary (``flush()``) releases it so legitimately argument-less tools
        (e.g. ``list_jobs``, whose schema has no required params) still run.
    """

    def __init__(self) -> None:
        # call_id → raw translated frame (JSON str) waiting for its arguments.
        self._parked: dict[str, str] = {}
        # call_ids whose announcement was already forwarded — later repeats
        # (whichever event order DashScope picks) must not double-fire.
        self._sent: set[str] = set()

    def on_function_call(self, call_id: str, arguments: str, raw_frame: str) -> str | None:
        """Decide whether ``raw_frame`` (a translated ``function_call``) should
        be forwarded now. Returns the frame to send, or ``None`` to hold/drop it.
        """
        if not call_id or call_id in self._sent:
            return None
        if _has_arguments(arguments):
            self._sent.add(call_id)
            self._parked.pop(call_id, None)
            return raw_frame
        self._parked[call_id] = raw_frame
        return None

    def flush(self) -> list[str]:
        """Release every still-parked announcement (response boundary reached
        and no arguments-bearing copy ever arrived). Returns frames to send.
        """
        frames = list(self._parked.values())
        self._parked = {}
        return frames

DEFAULT_INSTRUCTIONS = (
    '你是 Quanta，用户友好的中文语音助手。请用简洁、自然、口语化的中文回答，'
    '适合通过语音直接朗读。回答控制在两三句话以内，除非用户明确要求详细说明。'
)


class _Callback(OmniRealtimeCallback):
    """Bridge the SDK's thread-based callbacks into our asyncio queue.

    The SDK delivers every parsed event through ``on_event(message)`` while
    its ``WebSocketApp`` runs on a daemon thread. To stay inside the FastAPI
    asyncio loop we push to a ``loop.call_soon_threadsafe`` queue and let
    :meth:`OmniRealtimeProxy.upstream_events` drain it as an async iterator.

    ``message`` is delivered as the parsed JSON ``dict`` (the SDK does the
    ``json.loads`` for us in ``_on_message``). We re-encode it back to a JSON
    string before placing it on the queue so the consumer side contract
    (``translate_event`` expects a JSON string) is unchanged from the
    previous hand-rolled proxy.
    """

    def __init__(self, loop: asyncio.AbstractEventLoop, queue: asyncio.Queue) -> None:
        self._loop = loop
        self._queue = queue

    def on_open(self) -> None:
        # `connect()` already blocked until the underlying WS was up; nothing
        # to signal. Empty callback (per the SDK interface) — kept explicit so
        # future code can hook the open boundary if needed.
        return

    def on_close(self, close_status_code, close_msg) -> None:
        # Upstream died; release the upstream iterator.
        self._safe_put(_STOP_SENTINEL)

    def on_event(self, message: Any) -> None:
        # `message` is the parsed JSON dict; the previous proxy contract
        # handed the FastAPI handler raw JSON strings, so re-encode here to
        # avoid breaking ``translate_event``.
        try:
            encoded = json.dumps(message, ensure_ascii=False)
        except (TypeError, ValueError):
            log.warning("omni-realtime: dropping non-JSON-serialisable event: %r", message)
            return
        self._safe_put(encoded)

    def _safe_put(self, item: Any) -> None:
        try:
            self._loop.call_soon_threadsafe(self._queue.put_nowait, item)
        except RuntimeError:
            # Loop is closed (proxy teardown raced with an SDK callback).
            # Nothing left to do — the SDK thread is going away too.
            pass


class OmniRealtimeProxy:
    """Bridges one frontend WS to one DashScope Omni-Realtime upstream via the
    official SDK.

    Lifecycle:

        proxy = OmniRealtimeProxy(voice="Tina", instructions="...")
        await proxy.connect()                 # opens upstream + configures session
        await proxy.send_audio(pcm_bytes)     # binary frame, PCM16@16k mono
        await proxy.commit_audio()            # optional: flush buffer (server VAD also flushes)
        await proxy.cancel()                  # abort current response
        await proxy.close()

    The proxy translates between the SDK's event stream and the small
    frontend protocol documented in the module docstring.
    """

    def __init__(
        self,
        model: str | None = None,
        voice: str | None = None,
        instructions: str | None = None,
        tools: list[dict] | None = None,
        turn_silence_ms: int = 800,
    ) -> None:
        self.model = model or settings.omni_realtime_model
        self.voice = voice or settings.omni_realtime_voice
        self.instructions = instructions or settings.omni_realtime_instructions or DEFAULT_INSTRUCTIONS
        # Function-calling tools (OpenAI-Realtime flat format:
        # {"type": "function", "name", "description", "parameters"}). The
        # client owns execution — the proxy only relays calls and results.
        self.tools = [dict(tool) for tool in tools or [] if isinstance(tool, dict)]
        self.turn_silence_ms = max(300, min(1200, int(turn_silence_ms)))
        # Local session id (a uuid we mint; replaced by the SDK's authoritative
        # session id once `session.created` arrives in upstream_events()).
        self.session_id = str(uuid.uuid4())
        # asyncio bridge state — populated by connect(), torn down by close().
        self._loop: asyncio.AbstractEventLoop | None = None
        self._queue: asyncio.Queue | None = None
        self._conversation: OmniRealtimeConversation | None = None
        self._closed = False
        # Response-lifecycle gate: DashScope rejects any attempt to create a
        # new response while one is still in flight with
        # "Conversation already has an active response". The proxy observes
        # `response.created` / `response.done` / `response.cancelled` and gates
        # the actions that can trigger a new response (`commit_audio`,
        # `send_tool_output`) on the previous one fully draining.
        self._response_active = False
        self._response_done_event = asyncio.Event()
        self._response_done_event.set()
        # DashScope requires at least one audio append before any image frame
        # ("You must send audio data at least once before you send image data").
        # We track it so camera frames arriving before the mic feed drop
        # silently instead of surfacing a confusing upstream error.
        self._audio_seen = False
        # ...and the audio + image buffers are BOTH cleared on every
        # `input_audio_buffer.commit` (in VAD mode the server auto-commits at
        # the end of each utterance), so the "audio before image" rule applies
        # per commit cycle, not just per session. Track whether fresh audio has
        # been appended since the last observed commit so a camera frame that
        # lands in the post-commit window is dropped locally instead of
        # surfacing DashScope's "append image before append audio" error.
        self._audio_appended_since_commit = False
        # Counter for observability: send_image logs the first frame and then
        # every 60th (~1/min at the recommended 1 fps), so operators can see
        # camera frames actually flowing without flooding the log.
        self._image_frames_sent = 0

    # --- upstream lifecycle --------------------------------------------------

    async def connect(self) -> None:
        """Open the upstream SDK WS, configure the session, and ready for input."""
        if not settings.dashscope_api_key:
            raise RuntimeError("DASHSCOPE_API_KEY is not configured")

        # Region-routed URL: if OMNI_REALTIME_WORKSPACE_ID is set, rewrite the
        # bare international URL into the docs-mandated
        # `wss://{WorkspaceId}.{region}.maas.aliyuncs.com/api-ws/v1/realtime`
        # form. Operators that need a non-default region (Singapore: `.sg.`)
        # can override OMNI_REALTIME_WS_URL entirely.
        base = settings.omni_realtime_ws_url
        if settings.omni_realtime_workspace_id and "{WorkspaceId}" not in base:
            # Only auto-fill if the operator left the bare URL — never clobber
            # an explicit region-specific override.
            if base.startswith("wss://dashscope.aliyuncs.com/"):
                base = (
                    f"wss://{settings.omni_realtime_workspace_id}."
                    f"cn-beijing.maas.aliyuncs.com/"
                    f"{base[len('wss://dashscope.aliyuncs.com/'):]}"
                )
        # The SDK appends `?model=<name>` to the base URL itself, so we hand
        # it the bare URL.
        if self._loop is None:
            self._loop = asyncio.get_running_loop()
        if self._queue is None:
            self._queue = asyncio.Queue()

        callback = _Callback(self._loop, self._queue)
        self._conversation = OmniRealtimeConversation(
            model=self.model,
            callback=callback,
            url=base,
            api_key=settings.dashscope_api_key,
            workspace=settings.omni_realtime_workspace_id or None,
        )

        log.info(
            "omni-realtime: connecting via SDK to %s?model=%s (session=%s)",
            base,
            self.model,
            self.session_id,
        )

        # The SDK's `connect()` blocks (busy-poll up to 5 s) on the WS
        # handshake. Run it on a worker thread so concurrent sessions and
        # other FastAPI handlers keep moving.
        try:
            await asyncio.to_thread(self._conversation.connect)
        except Exception as exc:
            diagnosis = None
            if isinstance(exc, TimeoutError):
                diagnosis = await asyncio.to_thread(
                    diagnose_realtime_handshake,
                    self._conversation.url,
                    settings.dashscope_api_key,
                    settings.omni_realtime_workspace_id or None,
                )
            try:
                await asyncio.to_thread(self._conversation.close)
            except Exception:
                pass
            self._conversation = None
            if diagnosis:
                raise RuntimeError(diagnosis) from exc
            raise

        # Configure the session through the SDK. The SDK forwards arbitrary
        # kwargs into the `session.update` payload, which lets us keep the
        # previous tool-choice / enable_search semantics without re-implementing
        # the wire format.
        update_kwargs: dict[str, Any] = {
            "input_audio_format": AudioFormat.PCM_16000HZ_MONO_16BIT,
            "output_audio_format": AudioFormat.PCM_24000HZ_MONO_16BIT,
            "enable_input_audio_transcription": True,
            # Server-VAD is the SDK's documented default for qwen3-omni-flash
            # and the qwen3.8 family; hands-free UX is unchanged from the
            # previous proxy.
            "enable_turn_detection": True,
            "turn_detection_type": "server_vad",
            "turn_detection_threshold": 0.5,
            "turn_detection_silence_duration_ms": self.turn_silence_ms,
        }
        if self.tools:
            # Tool calling is incompatible with enable_search per the docs;
            # when tools are present, the SDK forwards `tools` and
            # `tool_choice="auto"` into the session.update payload.
            update_kwargs["tools"] = self.tools
            update_kwargs["tool_choice"] = "auto"
        try:
            self._conversation.update_session(
                output_modalities=[MultiModality.TEXT, MultiModality.AUDIO],
                voice=self.voice,
                instructions=self.instructions,
                **update_kwargs,
            )
        except Exception as exc:
            log.exception("omni-realtime: session.update failed: %s", exc)
            await self.close()
            raise

        log.info(
            "omni-realtime: session ready (model=%s, voice=%s, tools=%d)",
            self.model,
            self.voice,
            len(self.tools),
        )

    async def send_audio(self, pcm_bytes: bytes) -> None:
        """Append a binary PCM16 chunk to the upstream input_audio_buffer."""
        if self._conversation is None or self._closed:
            raise RuntimeError("omni-realtime: upstream not connected")
        if not pcm_bytes:
            return
        self._audio_seen = True
        self._audio_appended_since_commit = True
        audio_b64 = base64.b64encode(pcm_bytes).decode("ascii")
        # SDK's `append_audio` is synchronous (websocket-client send); run it
        # on a worker thread so a slow send never stalls the event loop.
        await asyncio.to_thread(self._conversation.append_audio, audio_b64)

    async def send_image(self, image: str) -> None:
        """Append one JPEG camera frame to the upstream input_image_buffer.

        DashScope's Omni-Realtime API accepts frames via
        ``input_image_buffer.append`` with the image as raw base64 (no data
        URL prefix). The browser ``canvas.toDataURL`` payload arrives with a
        ``data:image/jpeg;base64,`` prefix, so we strip it before forwarding.

        Upstream constraints (see official docs): JPG/JPEG only, single image
        ≤ 256 KB base64, ~1 fps recommended, and audio must have been
        appended first. The check is per commit cycle, not just per session:
        DashScope commits (and thereby clears) the audio + image buffers on
        every ``input_audio_buffer.commit`` (in VAD mode the server
        auto-commits at the end of each utterance), so a frame arriving
        after a commit but before the next audio append would be rejected
        with "append image before append audio". ``_audio_seen`` guards the
        session start; ``_audio_appended_since_commit`` guards every
        post-commit window.
        """
        if self._conversation is None or self._closed:
            raise RuntimeError("omni-realtime: upstream not connected")
        if not self._audio_seen:
            log.warning("omni-realtime: dropping image frame — no audio appended yet")
            return
        if not self._audio_appended_since_commit:
            log.warning(
                "omni-realtime: dropping image frame — no audio appended since the last "
                "input_audio_buffer commit (DashScope clears the image buffer on commit "
                "and requires a fresh audio append before each image frame)",
            )
            return
        image = (image or "").strip()
        if not image:
            return
        if image.startswith("data:"):
            _, _, image = image.partition(",")
            image = image.strip()
        if not image:
            return
        # SDK's `append_video` is synchronous (websocket-client send); run it
        # on a worker thread so a slow send never stalls the event loop.
        await asyncio.to_thread(self._conversation.append_video, image)
        self._image_frames_sent += 1
        if self._image_frames_sent == 1 or self._image_frames_sent % 60 == 0:
            log.info(
                "omni-realtime: forwarded image frame #%d (base64 %d chars, session=%s)",
                self._image_frames_sent,
                len(image),
                self.session_id,
            )

    async def commit_audio(self) -> None:
        """Commit the buffered audio upstream (server VAD also does this automatically).

        Used by push-to-talk clients that want to force the model to respond
        even before VAD closes the turn. Without this the server waits for
        its own speech-stopped event.

        If a response is still in flight when the commit arrives we wait for
        it to finish before sending — otherwise DashScope's auto-create logic
        collides with the live response and returns
        "Conversation already has an active response".
        """
        if self._conversation is None or self._closed:
            return
        await self._await_response_done("commit_audio")
        try:
            await asyncio.to_thread(self._conversation.commit)
        except Exception as exc:
            log_skip("omni_realtime_commit_audio", exc)

    async def cancel(self) -> None:
        """Abort the current in-flight response (used by PTT release)."""
        if self._conversation is None or self._closed:
            return
        try:
            await asyncio.to_thread(self._conversation.cancel_response)
        except Exception as exc:
            log_skip("omni_realtime_cancel", exc)

    async def send_tool_output(self, call_id: str, output: str) -> None:
        """Return a client-side function-call result and ask for the next turn.

        Follows the OpenAI-Realtime shape: append a `function_call_output`
        conversation item, then trigger `response.create` so the model
        speaks the answer that uses the tool result.

        `response.create` MUST wait for the in-flight response to drain —
        `response.function_call_arguments.done` arrives *before* `response.done`
        for the same turn, so firing `response.create` immediately would
        race with the still-active response and DashScope would reject with
        "Conversation already has an active response".
        """
        if self._conversation is None or self._closed or not call_id:
            return
        await self._await_response_done("send_tool_output")
        item = {
            "type": "function_call_output",
            "call_id": call_id,
            "output": output,
        }
        try:
            await asyncio.to_thread(self._conversation.create_item, item)
            await asyncio.to_thread(self._conversation.create_response)
        except Exception as exc:
            log_skip("omni_realtime_send_tool_output", exc)

    async def send_text(self, text: str) -> None:
        """Inject a text-only user message and ask for a reply (same session).

        Used by the practice stage's closing review: instead of ending the
        session and opening a fresh full-modal request, the client sends the
        review prompt as plain text so the model answers *within the same
        realtime session*, reusing the audio/video context it already heard
        and saw. The answer comes back as the model's spoken response whose
        ASR transcript is relayed to the client as usual.
        """
        if self._conversation is None or self._closed:
            raise RuntimeError("omni-realtime: upstream not connected")
        prompt = str(text or "").strip()
        if not prompt:
            return
        await self._await_response_done("send_text")
        item = {
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": prompt}],
        }
        try:
            await asyncio.to_thread(self._conversation.create_item, item)
            await asyncio.to_thread(self._conversation.create_response)
        except Exception as exc:
            log_skip("omni_realtime_send_text", exc)

    async def _await_response_done(self, action: str, timeout: float = 30.0) -> None:
        """Block until no response is in flight, with a safety timeout.

        The upstream can stall in pathological cases (network blip mid-turn,
        model timeout, etc.); we don't want a single stuck response to wedge
        every subsequent client action forever. If the timeout fires we log
        and proceed — the resulting upstream error will be surfaced to the
        client as a normal `error` event.
        """
        if not self._response_active:
            return
        try:
            await asyncio.wait_for(self._response_done_event.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            log.warning(
                "omni-realtime: %s timed out waiting %.1fs for in-flight response to drain; proceeding anyway",
                action,
                timeout,
            )

    # --- upstream event pump ---------------------------------------------------

    async def upstream_events(self) -> AsyncIterator[str]:
        """Yield raw JSON strings from the upstream.

        Returns ``str`` (not ``bytes``) because the SDK never delivers binary
        frames — the previous proxy forwarded audio deltas as raw PCM16
        bytes, but the SDK base64-decodes for us inside
        ``_on_message`` and hands us the parsed JSON event. We re-encode on
        the way out so the consumer contract (``translate_event``) is
        unchanged.

        Side effects: update ``_response_active`` / ``_response_done_event``
        / ``_audio_appended_since_commit`` from each event so the gating
        logic in ``send_tool_output`` / ``commit_audio`` / ``send_text``
        sees consistent state when the FastAPI handler races against
        upstream lifecycle events.
        """
        if self._queue is None:
            raise RuntimeError("omni-realtime: upstream not connected")
        while True:
            item = await self._queue.get()
            if item is _STOP_SENTINEL:
                return
            if not isinstance(item, str):
                # Defensive: the queue only ever holds strings + sentinel; if
                # a future change puts another shape here, log + drop instead
                # of crashing the pump.
                log.warning("omni-realtime: dropping unexpected queue item: %r", item)
                continue
            # Observe lifecycle events BEFORE yielding so the consumer sees a
            # consistent snapshot. We only inspect events we care about — the
            # full translation still happens in `translate_event`.
            try:
                msg = json.loads(item)
            except json.JSONDecodeError:
                yield item
                continue
            evt = msg.get("type") or msg.get("event")
            if evt == "response.created":
                self._response_active = True
                self._response_done_event.clear()
            elif evt in ("response.done", "response.cancelled"):
                if self._response_active:
                    self._response_active = False
                    self._response_done_event.set()
            elif evt in (
                "input_audio_buffer.speech_started",
                "input_audio_buffer.speech_stopped",
                "input_audio_buffer.committed",
                "input_audio_buffer.cleared",
            ):
                # DashScope commits (and thereby clears) the audio + image
                # buffers at the end of each VAD utterance, and truncates
                # the buffer at speech onset. Until fresh audio is appended
                # again any image frame would be rejected with "append
                # image before append audio" — reset the freshness flag so
                # `send_image` drops frames that land in the post-commit
                # window.
                self._audio_appended_since_commit = False
            elif evt == "session.created":
                # The SDK hands us an authoritative session id from upstream;
                # surface it as our own so log lines + downstream callers
                # match what the upstream actually created.
                session = msg.get("session") or {}
                upstream_sid = session.get("id")
                if upstream_sid:
                    self.session_id = upstream_sid
            yield item

    async def close(self) -> None:
        """Tear the session down cleanly.

        Per the Bailian docs, each session should be ended with a
        `session.finish` event so the server can flush its audio buffer and
        release the context window — leaving the WS dangling just leaks
        context until the 120-minute hard limit kicks in.
        """
        if self._closed:
            return
        self._closed = True
        conversation = self._conversation
        # Release the upstream iterator first so the pump task returns even
        # if the SDK close hangs.
        if self._queue is not None and self._loop is not None:
            try:
                self._loop.call_soon_threadsafe(self._queue.put_nowait, _STOP_SENTINEL)
            except RuntimeError:
                pass
        if conversation is not None:
            try:
                # Send session.finish async (no waiting), then close. The
                # SDK will dispatch on_close shortly after, which would
                # also push the sentinel — call_soon_threadsafe above is
                # idempotent against that.
                conversation.end_session_async()
            except Exception as exc:
                log_skip("omni_realtime_session_finish", exc)
            try:
                await asyncio.to_thread(conversation.close)
            except Exception as exc:
                log_skip("omni_realtime_close", exc)
            self._conversation = None


def translate_event(raw: str | bytes) -> str | bytes | None:
    """Translate an upstream event into the small frontend protocol.

    Returns ``None`` for events we deliberately drop (heartbeats, usage
    accounting, etc.) — the caller treats ``None`` as "skip this frame".

    Audio delta events are special: the upstream payload includes the audio
    as a base64 string. We decode it and yield the raw PCM16 bytes so the
    browser can write them straight into a Web Audio buffer.
    """
    if isinstance(raw, (bytes, bytearray)):
        # DashScope occasionally emits upstream-level binary pings. Forwarding
        # them as binary would confuse the client, so silently drop.
        return None
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        return None

    event = msg.get("type") or msg.get("event")

    # Audio delta → raw PCM16 bytes.
    if event == "response.audio.delta":
        delta = (msg.get("delta") or "").strip()
        if not delta:
            return None
        try:
            return base64.b64decode(delta)
        except Exception as exc:
            log.warning("omni-realtime: bad base64 audio delta: %s", exc)
            return None

    if event == "response.audio_transcript.delta":
        text = msg.get("delta") or ""
        if not text:
            return None
        return json.dumps({"type": "transcript_delta", "text": text}, ensure_ascii=False)

    if event == "response.audio_transcript.done":
        text = msg.get("transcript") or ""
        return json.dumps({"type": "transcript", "text": text}, ensure_ascii=False)

    if event == "conversation.item.input_audio_transcription.completed":
        transcript = msg.get("transcript") or ""
        return json.dumps({"type": "user_transcript", "text": transcript}, ensure_ascii=False)

    if event == "input_audio_buffer.speech_started":
        return json.dumps({"type": "listening"}, ensure_ascii=False)

    if event == "input_audio_buffer.speech_stopped":
        return json.dumps({"type": "speech_stopped"}, ensure_ascii=False)

    if event == "response.created":
        return json.dumps({"type": "response_started"}, ensure_ascii=False)

    if event == "response.done":
        return json.dumps({"type": "response_done"}, ensure_ascii=False)

    # DashScope emits `response.cancelled` when the client sends
    # `response.cancel` mid-stream. We translate it to the same
    # `response_done` frame the client already understands — both events
    # mean "the response is fully drained, no more audio / text for it" —
    # so the client can clear its post-cancel audio-drop window without
    # needing a separate event type.
    if event == "response.cancelled":
        return json.dumps({"type": "response_done"}, ensure_ascii=False)

    # Function calling: the canonical payload lives in the `.done` event.
    # `conversation.item.created` repeats the same call for protocol
    # bookkeeping — and may arrive FIRST with empty `arguments` while the
    # model is still filling them in. The caller feeds both copies through a
    # `FunctionCallGate` (keyed by call_id) so the client never executes an
    # announcement whose real arguments are still on the wire.
    if event == "response.function_call_arguments.done":
        return json.dumps({
            "type": "function_call",
            "call_id": msg.get("call_id") or "",
            "name": msg.get("name") or "",
            "arguments": _as_arguments_json(msg.get("arguments")),
        }, ensure_ascii=False)

    item = msg.get("item")
    if event == "conversation.item.created" and isinstance(item, dict) and item.get("type") == "function_call":
        return json.dumps({
            "type": "function_call",
            "call_id": item.get("call_id") or "",
            "name": item.get("name") or "",
            "arguments": _as_arguments_json(item.get("arguments")),
        }, ensure_ascii=False)

    if event == "error":
        err = msg.get("error") or {}
        message = err.get("message") if isinstance(err, dict) else str(err)
        if not message:
            message = "unknown upstream error"
        # The proxy enforces "no image without fresh audio" locally via
        # `_audio_appended_since_commit`. If a stale image still slips
        # through and DashScope complains, the user never asked for that
        # frame — drop the error silently. Only the server has the local
        # pre-filter context, so the filter belongs here (not the client).
        if isinstance(message, str) and "append image before append audio" in message.lower():
            return None
        return json.dumps({"type": "error", "message": message}, ensure_ascii=False)

    # Everything else (session events, response.audio.done, usage, etc.) is
    # either redundant with what we forward or pure protocol bookkeeping.
    return None
