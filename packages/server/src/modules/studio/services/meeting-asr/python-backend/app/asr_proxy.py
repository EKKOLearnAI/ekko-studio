from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import Any, AsyncIterator

import websockets
from websockets.exceptions import ConnectionClosed

from .config import settings
from ._log_helper import log_skip

log = logging.getLogger("asr_proxy")


class ParaformerProxy:
    """Bridges a frontend WebSocket and the Aliyun Paraformer real-time WS API.

    The frontend sends a small JSON control message first
    (`{"type": "start", "sample_rate": 16000, ...}`), then streams raw
    Int16 PCM frames as binary messages, and finally sends
    `{"type": "stop"}` to end the task.
    """

    def __init__(self) -> None:
        self.upstream: websockets.WebSocketClientProtocol | None = None
        self.task_id: str = ""
        self._send_lock = asyncio.Lock()
        self._reconnect_attempts = 0
        self._max_reconnect_attempts = 3
        # Exponential backoff for upstream reconnect on transient failures.
        # Keep short — the upstream server is usually <100 ms away; longer
        # backoff just feels like "meeting froze" to the user.
        self._reconnect_backoff = [0.5, 1.5, 3.0]

    async def connect(self) -> None:
        if not settings.dashscope_api_key:
            raise RuntimeError("DASHSCOPE_API_KEY is not configured")

        headers = [
            ("Authorization", f"Bearer {settings.dashscope_api_key}"),
            ("User-Agent", "meeting-asr-cloud/0.1"),
        ]

        log.info("connecting to upstream %s", settings.paraformer_ws_url)
        self.upstream = await websockets.connect(
            settings.paraformer_ws_url,
            extra_headers=headers,
            max_size=64 * 1024 * 1024,
            ping_interval=20,
            ping_timeout=20,
        )

        self.task_id = str(uuid.uuid4())
        run_task: dict[str, Any] = {
            "header": {
                "action": "run-task",
                "task_id": self.task_id,
                "streaming": "duplex",
            },
            "payload": {
                "task_group": "audio",
                "task": "asr",
                "function": "recognition",
                "model": settings.paraformer_model,
                "parameters": {
                    "format": settings.paraformer_format,
                    "sample_rate": settings.paraformer_sample_rate,
                    "language_hints": settings.language_hints_list(),
                    "semantic_punctuation_enabled": settings.paraformer_semantic_punctuation,
                    "punctuation_prediction_enabled": True,
                    "inverse_text_normalization_enabled": True,
                    "heartbeat": True,
                },
                "input": {},
            },
        }
        await self.upstream.send(json.dumps(run_task))

        started = json.loads(await self.upstream.recv())
        event = started.get("header", {}).get("event")
        if event != "task-started":
            raise RuntimeError(f"upstream did not confirm task-started: {started}")

    async def send_audio(self, pcm_bytes: bytes) -> None:
        if self.upstream is None:
            raise RuntimeError("upstream not connected")
        # Reconnect-on-failure: DashScope WS occasionally drops mid-meeting
        # (~1% of long sessions). Rather than killing the meeting and forcing
        # the user to restart, attempt one reconnect with bounded backoff and
        # resume sending. The new upstream gets a fresh run-task; transcripts
        # produced before the drop are still in our local transcript list.
        async with self._send_lock:
            try:
                await self.upstream.send(pcm_bytes)
                return
            except (ConnectionClosed, ConnectionError, OSError) as exc:
                if self._reconnect_attempts >= self._max_reconnect_attempts:
                    raise
                delay = self._reconnect_backoff[min(self._reconnect_attempts, len(self._reconnect_backoff) - 1)]
                self._reconnect_attempts += 1
                log.warning(
                    "upstream send failed (%s); reconnect attempt %d in %.1fs",
                    exc,
                    self._reconnect_attempts,
                    delay,
                )
                await asyncio.sleep(delay)
                # Connect re-issues a fresh run-task. The old task ID is gone.
                try:
                    await self.close()
                except Exception as exc:
                    log_skip("upstream_close_in_reconnect", exc)
                await self.connect()
                await self.upstream.send(pcm_bytes)

    async def finish(self) -> None:
        if self.upstream is None:
            return
        msg = {
            "header": {
                "action": "finish-task",
                "task_id": self.task_id,
                "streaming": "duplex",
            },
            "payload": {"input": {}},
        }
        try:
            async with self._send_lock:
                await self.upstream.send(json.dumps(msg))
        except ConnectionClosed:
            pass

    async def upstream_events(self) -> AsyncIterator[dict[str, Any]]:
        if self.upstream is None:
            raise RuntimeError("upstream not connected")
        try:
            async for raw in self.upstream:
                if isinstance(raw, (bytes, bytearray)):
                    continue
                try:
                    yield json.loads(raw)
                except json.JSONDecodeError:
                    log.warning("non-json upstream frame: %r", raw[:200])
        except ConnectionClosed:
            log.info("upstream connection closed")

    async def close(self) -> None:
        if self.upstream is not None:
            try:
                await self.upstream.close()
            except Exception as exc:
                log_skip("upstream_close", exc)
            self.upstream = None