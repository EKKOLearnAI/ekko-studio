"""Diarize route layer: the FastAPI WebSocket endpoint.

Split from the former monolith (v0.8 modularization): session types, chunk
processing and the PCM fallback live in diarize_service.py; this module
keeps the route (`diarize_ws_handler`) that diarize_server.py imports.
Routes, request/response message shapes and status codes are unchanged.
"""
from __future__ import annotations

import asyncio
import json
import logging
import traceback

from fastapi import WebSocket, WebSocketDisconnect

from .config import settings
from .diarize_proxy import cleanup_session_files, new_session_id
from ._log_helper import log_skip
from .diarize_service import (
    DiarizeSession,
    SessionConfig,
    _bytes_per_overlap,
    _process_chunk_async,
    _processor_loop,
    _run_ws_transcribe,
    _send,
    _ws_result_to_chunk_result,
)

log = logging.getLogger("diarize_endpoint")


async def diarize_ws_handler(ws: WebSocket) -> None:
    """FastAPI WebSocket endpoint for speaker-diarized transcription.

    Two processing modes, auto-selected at connect time:
    - OSS configured → split PCM into chunks, upload WAV to OSS, submit
      each chunk to paraformer-v2 file-based REST API (original flow).
    - No OSS       → buffer all PCM, then send to paraformer-realtime
      WebSocket API in one streaming session (PCM direct, no OSS needed).
    """
    await ws.accept()

    session: DiarizeSession | None = None
    fallback_mode = not settings.oss_configured
    try:
        first = await ws.receive()
        if "text" not in first:
            await _send(ws, {"type": "error", "message": "expected JSON start frame"})
            await ws.close()
            return
        try:
            start_msg = json.loads(first["text"])
        except json.JSONDecodeError:
            await _send(ws, {"type": "error", "message": "invalid start JSON"})
            await ws.close()
            return
        if start_msg.get("type") != "start":
            await _send(
                ws,
                {"type": "error", "message": 'first frame must be {"type":"start", ...}'},
            )
            await ws.close()
            return

        sample_rate = int(start_msg.get("sample_rate") or settings.asr_sample_rate)
        speaker_count = start_msg.get("speaker_count")
        if speaker_count in (0, None, "", "auto"):
            speaker_count = None
        else:
            try:
                speaker_count = max(2, min(100, int(speaker_count)))
            except (TypeError, ValueError):
                speaker_count = None

        cfg = SessionConfig(
            sample_rate=sample_rate,
            speaker_count=speaker_count,
            language_hints=settings.language_hints_list(),
        )

        if fallback_mode:
            # ── WS fallback: buffer all PCM, process on stop ──
            log.info("diarize fallback mode (no OSS) — buffering PCM for batch WS transcribe")
            session = DiarizeSession(
                session_id=new_session_id(),
                config=cfg,
                ws=ws,
            )
            await _send(
                ws,
                {
                    "type": "ready",
                    "session_id": session.session_id,
                    "sample_rate": cfg.sample_rate,
                    "fallback_mode": True,
                    "note": "OSS not configured; using PCM-direct WebSocket fallback",
                },
            )

            while not session._closed:
                try:
                    frame = await ws.receive()
                except (WebSocketDisconnect, RuntimeError):
                    break
                if "bytes" in frame:
                    data = frame["bytes"]
                    if not data:
                        continue
                    session.audio_buffer.extend(data)
                    max_bytes = cfg.sample_rate * 2 * settings.asr_max_audio_seconds
                    if len(session.audio_buffer) > max_bytes:
                        del session.audio_buffer[: len(session.audio_buffer) - max_bytes]
                elif "text" in frame:
                    try:
                        msg = json.loads(frame["text"])
                    except json.JSONDecodeError:
                        continue
                    if msg.get("type") == "stop":
                        session._closed = True
                        break
                    elif msg.get("type") == "set_speaker_count":
                        try:
                            new_count = msg.get("value")
                            if new_count in (0, None, "", "auto"):
                                session.config.speaker_count = None
                            else:
                                session.config.speaker_count = max(2, min(100, int(new_count)))
                        except (TypeError, ValueError):
                            pass

            # Process the accumulated buffer via WS API
            if session.audio_buffer and len(session.audio_buffer) > cfg.sample_rate * 2:
                audio_dur = len(session.audio_buffer) / (cfg.sample_rate * 2)
                log.info("diarize: processing buffer duration=%.1fs bytes=%d sample_rate=%d",
                         audio_dur, len(session.audio_buffer), cfg.sample_rate)
                await _send(ws, {"type": "processing", "message": "transcribing via WebSocket API (direct PCM)"})
                try:

                    uvicorn_loop = asyncio.get_running_loop()

                    def _forward_sentence(s: dict) -> None:
                        """Forward a complete sentence to the frontend (sync, called from worker thread)."""
                        asyncio.run_coroutine_threadsafe(
                            _send(ws, {
                                "type": "final",
                                "text": s["text"],
                                "begin_time": s.get("begin_time", 0),
                                "end_time": s.get("end_time", 0),
                            }),
                            uvicorn_loop,
                        )

                    ws_result = await _run_ws_transcribe(
                        pcm=bytes(session.audio_buffer),
                        sample_rate=cfg.sample_rate,
                        speaker_count=cfg.speaker_count,
                        language_hints=cfg.language_hints,
                        on_sentence=_forward_sentence,
                    )
                    log.info("diarize: transcription returned sentences=%d text_len=%d",
                             len(ws_result.sentences), len(ws_result.text))
                    if ws_result.sentences:
                        chunk_result = _ws_result_to_chunk_result(
                            ws_result, chunk_index=0, offset_sec=0.0,
                        )
                        log.info("diarize: sending transcript with %d sentences", len(chunk_result.get("sentences", [])))
                        await _send(ws, chunk_result)
                    else:
                        log.info("diarize: no sentences from transcription, sending empty result")
                except Exception as exc:
                    tb = traceback.format_exc()
                    log.error("WS fallback transcribe failed:\n%s", tb)
                    await _send(ws, {"type": "error", "message": f"fallback transcribe failed: {exc}\n{tb}"})

            await _send(ws, {"type": "stopped"})
        else:
            # ── OSS flow: chunk-based with upload → REST API ──
            session = DiarizeSession(
                session_id=new_session_id(),
                config=cfg,
                ws=ws,
                overlap_bytes=_bytes_per_overlap(cfg),
            )
            session._processor_task = asyncio.create_task(_processor_loop(session))

            await _send(
                ws,
                {
                    "type": "ready",
                    "session_id": session.session_id,
                    "chunk_seconds": cfg.chunk_seconds,
                    "overlap_seconds": cfg.overlap_seconds,
                    "sample_rate": cfg.sample_rate,
                    "speaker_count_hint": cfg.speaker_count,
                },
            )

            while not session._closed:
                try:
                    frame = await ws.receive()
                except (WebSocketDisconnect, RuntimeError):
                    break

                if "bytes" in frame:
                    data = frame["bytes"]
                    if not data:
                        continue
                    session.audio_buffer.extend(data)
                    max_bytes = cfg.sample_rate * 2 * settings.asr_max_audio_seconds
                    if len(session.audio_buffer) > max_bytes:
                        del session.audio_buffer[: len(session.audio_buffer) - max_bytes]
                elif "text" in frame:
                    try:
                        msg = json.loads(frame["text"])
                    except json.JSONDecodeError:
                        continue
                    mtype = msg.get("type")
                    if mtype == "stop":
                        session._closed = True
                        # Process any remaining buffer as final chunk.
                        async with session._lock:
                            remaining = bytes(session.audio_buffer)
                            session.audio_buffer.clear()
                        if remaining and len(remaining) > cfg.sample_rate:  # >= 0.5s
                            log.info("diarize: processing final chunk of %.1fs",
                                     len(remaining) / (cfg.sample_rate * 2))
                            await _process_chunk_async(
                                session, remaining,
                                offset_sec=session.submission_offset_sec,
                                chunk_idx=session.chunk_index,
                            )
                        break
                    elif mtype == "set_speaker_count":
                        try:
                            new_count = msg.get("value")
                            if new_count in (0, None, "", "auto"):
                                session.config.speaker_count = None
                            else:
                                session.config.speaker_count = max(2, min(100, int(new_count)))
                            await _send(
                                ws,
                                {
                                    "type": "speaker_count_updated",
                                    "value": session.config.speaker_count,
                                },
                            )
                        except (TypeError, ValueError):
                            pass

    except WebSocketDisconnect:
        log.info("diarize client disconnected")
    except Exception as exc:
        log.exception("ws_diarize error: %s", exc)
        await _send(ws, {"type": "error", "message": str(exc)})
    finally:
        if session is not None:
            session._closed = True
            if session._processor_task is not None:
                session._processor_task.cancel()
                try:
                    await session._processor_task
                except (asyncio.CancelledError, Exception):
                    pass
            if session._pending_tasks:
                for t in list(session._pending_tasks):
                    t.cancel()
                await asyncio.gather(*session._pending_tasks, return_exceptions=True)
                session._pending_tasks.clear()
            # Cleanup OSS files for this session
            try:
                loop = asyncio.get_running_loop()
                deleted_count = await loop.run_in_executor(
                    None, cleanup_session_files, session.session_id
                )
                log.info("Cleaned up %d OSS files for session %s", deleted_count, session.session_id)
            except Exception as cleanup_exc:
                log.error("Failed to cleanup OSS files: %s", cleanup_exc)
        try:
            await _send(ws, {"type": "stopped"})
        except Exception as exc:
            log_skip("diarize_stop_send", exc)