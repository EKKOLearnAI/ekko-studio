"""Whole-file (batch) transcription + speaker diarization.

Two providers, one job API:

* ``minimax`` — MiniMax Speech-to-Text REST
  (https://platform.minimax.cn/docs/api-reference/speech-to-text).
  ``response_format=verbose_json`` is the only mode that returns speaker
  labels (``segments[].speaker`` / ``n_speakers``). A single request is
  capped at 500 s / 50 MB, so longer recordings are split into rolling
  windows and the timestamps are shifted back onto the global timeline.

* ``qwen`` — Alibaba Cloud Model Studio (DashScope).
  Diarization is requested through the async file-transcription API
  (``paraformer-v2`` + ``diarization_enabled``), which only accepts a
  publicly reachable ``file_urls`` entry — i.e. OSS must be configured.
  Without OSS we fall back to the synchronous multimodal-generation
  endpoint (``qwen-audio-3.0-asr-flash``) with a base64 data URL, which is
  capped at 5 minutes and does **not** support diarization.

Everything enters as an uploaded container (webm/mp3/wav/m4a/…) and is
decoded to 16 kHz mono Int16 PCM by ``ffmpeg`` — a declared dependency of
the device/Docker deployments (see ``scripts/deploy-source-armbian.sh`` and
``Dockerfile``). ffmpeg is invoked with an argument array and stdin/stdout
pipes; no shell string is ever constructed.

Jobs are asynchronous: ``start_transcription`` returns a job id immediately
and the caller polls ``get_job``. This keeps long transcriptions off the
HTTP request/response path (a 2 h recording can take minutes to poll
through DashScope).
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import shutil
import sys
import tempfile
import time
import uuid
from typing import Any, Callable

import httpx

from .asr_minimax import _pcm_to_wav
from .config import settings
from .diarize_proxy import DiarizeClient, parse_sentences, upload_wav_to_oss, _normalize_base_url
from ._log_helper import log_skip

log = logging.getLogger("file_transcribe")

# MiniMax caps a single request at 500 s of audio and 50 MB. Leave headroom:
# 16 kHz mono Int16 is 32 kB/s, so 480 s ≈ 15 MB of WAV.
MINIMAX_MAX_CHUNK_SECONDS = 480.0
# Base64 inflates by 4/3 and the multimodal endpoint caps the payload at
# 10 MB, so keep the encoded WAV comfortably below that.
QWEN_SYNC_MAX_SECONDS = 300.0

SAMPLE_RATE = 16000
BYTES_PER_SECOND = SAMPLE_RATE * 2  # Int16 mono

# Uploaded audio is capped by the Node route as well; this is the second line
# of defence so a direct caller cannot OOM the uvicorn worker.
MAX_UPLOAD_BYTES = int(os.environ.get("TRANSCRIBE_MAX_UPLOAD_BYTES", str(250 * 1024 * 1024)))

# Keep the finished-job cache bounded — the frontend polls then drops the id.
MAX_JOBS = 50


# ── Job registry ──────────────────────────────────────────────────────────

_jobs: dict[str, dict[str, Any]] = {}


def _prune_jobs() -> None:
    if len(_jobs) <= MAX_JOBS:
        return
    ordered = sorted(_jobs.items(), key=lambda kv: kv[1].get("created_at", 0))
    for job_id, _ in ordered[: len(_jobs) - MAX_JOBS]:
        _jobs.pop(job_id, None)


def start_transcription(
    audio: bytes,
    *,
    engine: str,
    diarize: bool,
    speaker_count: int = 0,
    language: str = "",
    session_id: str = "",
) -> str:
    """Validate the request and start the background job; returns the job id."""
    engine = (engine or "minimax").strip().lower()
    if engine not in ("minimax", "qwen"):
        raise ValueError(f"unsupported engine: {engine}")
    if not audio:
        raise ValueError("empty audio payload")
    if len(audio) > MAX_UPLOAD_BYTES:
        raise ValueError(f"audio exceeds {MAX_UPLOAD_BYTES} bytes")

    job_id = uuid.uuid4().hex[:16]
    _jobs[job_id] = {
        "job_id": job_id,
        "status": "pending",
        "progress": 0.0,
        "message": "",
        "engine": engine,
        "diarize": bool(diarize),
        "created_at": time.time(),
        "result": None,
        "error": None,
    }
    _prune_jobs()
    asyncio.create_task(
        _run_job(
            job_id,
            audio,
            engine=engine,
            diarize=bool(diarize),
            speaker_count=int(speaker_count or 0),
            language=(language or "").strip(),
            session_id=(session_id or "").strip() or f"file-{job_id}",
        )
    )
    return job_id


def get_job(job_id: str) -> dict[str, Any] | None:
    return _jobs.get(job_id)


def _update(job_id: str, **fields: Any) -> None:
    job = _jobs.get(job_id)
    if job is not None:
        job.update(fields)


def _app_error_location() -> str:
    """Deepest traceback frame that belongs to this package, as ``[file:line]``.

    Surfacing the failing call site makes field reports diagnosable without
    digging through the uvicorn log — the raw exception message alone (e.g.
    "not enough values to unpack") gives no clue which call broke.
    """
    tb = sys.exc_info()[2]
    here = os.path.dirname(os.path.abspath(__file__))
    deepest = None
    while tb is not None:
        filename = os.path.abspath(tb.tb_frame.f_code.co_filename)
        if filename.startswith(here):
            deepest = tb
        tb = tb.tb_next
    if deepest is None:
        return ""
    return f" [{os.path.basename(deepest.tb_frame.f_code.co_filename)}:{deepest.tb_lineno}]"


async def _run_job(
    job_id: str,
    audio: bytes,
    *,
    engine: str,
    diarize: bool,
    speaker_count: int,
    language: str,
    session_id: str,
) -> None:
    _update(job_id, status="running", progress=0.02, message="decoding_audio")

    def progress(value: float, message: str = "") -> None:
        _update(job_id, progress=max(0.0, min(1.0, value)), message=message)

    try:
        pcm = await decode_audio_to_pcm(audio)
        duration_sec = len(pcm) / BYTES_PER_SECOND
        if duration_sec <= 0:
            raise RuntimeError("decoded audio is empty (no decodable audio stream)")
        log.info(
            "transcribe job %s: engine=%s diarize=%s duration=%.1fs bytes=%d",
            job_id, engine, diarize, duration_sec, len(pcm),
        )
        progress(0.15, "transcribing")

        if engine == "minimax":
            result = await _run_minimax(
                pcm, diarize=diarize, speaker_count=speaker_count,
                language=language, progress=progress,
            )
        else:
            result = await _run_qwen(
                pcm, diarize=diarize, speaker_count=speaker_count,
                language=language, session_id=session_id, progress=progress,
            )

        result.update({
            "engine": engine,
            "diarize": diarize,
            "duration_sec": round(duration_sec, 3),
            "sample_rate": SAMPLE_RATE,
        })
        _update(job_id, status="done", progress=1.0, message="done", result=result)
        log.info(
            "transcribe job %s done: sentences=%d speakers=%d",
            job_id, len(result.get("sentences", [])), len(result.get("speakers", [])),
        )
    except Exception as exc:  # noqa: BLE001 — surfaced to the poller verbatim
        log.exception("transcribe job %s failed", job_id)
        _update(
            job_id,
            status="error",
            message="error",
            error=f"{exc}{_app_error_location()}",
        )


# ── Audio decoding (ffmpeg) ───────────────────────────────────────────────

async def decode_audio_to_pcm(data: bytes, *, timeout_sec: float = 900.0) -> bytes:
    """Decode an arbitrary audio container to 16 kHz mono Int16 PCM."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError(
            "ffmpeg not found on PATH; install it (apt install ffmpeg / brew install ffmpeg) "
            "to transcribe uploaded audio"
        )

    tmp_path = None
    try:
        # Write the container to a seekable temp file: mp4/m4a carry their
        # index (moov) at the end, which a non-seekable stdin pipe cannot read.
        with tempfile.NamedTemporaryFile(prefix="transcribe-", suffix=".bin", delete=False) as fh:
            fh.write(data)
            tmp_path = fh.name

        proc = await asyncio.create_subprocess_exec(
            ffmpeg,
            "-hide_banner",
            "-nostdin",
            "-loglevel", "error",
            "-i", tmp_path,
            "-vn",
            "-f", "s16le",
            "-acodec", "pcm_s16le",
            "-ac", "1",
            "-ar", str(SAMPLE_RATE),
            "pipe:1",
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout_sec)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise RuntimeError(f"ffmpeg timed out after {timeout_sec:.0f}s")
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError as exc:
                log_skip("transcribe_tmp_unlink", exc)

    if proc.returncode != 0:
        detail = (stderr or b"").decode("utf-8", "replace").strip()
        raise RuntimeError(f"ffmpeg failed to decode audio: {detail[:400] or 'unknown error'}")
    if not stdout:
        raise RuntimeError("ffmpeg produced no audio (unsupported or empty stream)")
    return stdout


# ── MiniMax ───────────────────────────────────────────────────────────────

def _split_pcm(pcm: bytes, max_seconds: float) -> list[bytes]:
    window = max(int(BYTES_PER_SECOND * max_seconds), BYTES_PER_SECOND)
    return [pcm[i:i + window] for i in range(0, len(pcm), window)] or [b""]


async def _minimax_post(
    wav: bytes,
    *,
    diarize: bool,
    language: str,
) -> dict[str, Any]:
    endpoint = f"{(settings.minimax_base_url or 'https://api.minimaxi.com').rstrip('/')}/v1/speech_to_text"
    if not settings.minimax_api_key:
        raise RuntimeError("MINIMAX_API_KEY is not configured")

    # verbose_json is what returns segments[] + n_speakers. It cannot be
    # combined with stream=true (per the API docs), so always stream=false.
    # For the no-diarization case we still ask for verbose_json to keep
    # sentence timestamps, then drop the speaker labels on the way out.
    #
    # NOTE: plain form fields must go through `data=`, not `files=` — httpx
    # treats every `files=` entry as a file field and requires a 2/3/4-tuple,
    # so a 1-tuple raises "not enough values to unpack (expected 4, got 1)".
    form: dict[str, Any] = {
        "model": settings.minimax_asr_model or "asr-1.0",
        "response_format": "verbose_json",
        "timestamp_level": "sentence",
        "stream": "false",
    }
    if language:
        form["language"] = language
    files = {"file": ("audio.wav", wav, "audio/wav")}
    headers = {
        "Authorization": f"Bearer {settings.minimax_api_key}",
        "User-Agent": "meeting-asr-cloud/0.1",
    }
    async with httpx.AsyncClient(timeout=httpx.Timeout(300.0)) as client:
        resp = await client.post(endpoint, headers=headers, data=form, files=files)
    if resp.status_code >= 400:
        try:
            body = resp.json()
            message = (
                (body.get("error") or {}).get("message")
                or body.get("message")
                or resp.text
            )
        except Exception:
            message = resp.text or resp.reason_phrase
        raise RuntimeError(f"minimax http {resp.status_code}: {str(message)[:400]}")
    try:
        return resp.json()
    except json.JSONDecodeError:
        raise RuntimeError(f"minimax returned non-JSON body: {resp.text[:200]}")


async def _run_minimax(
    pcm: bytes,
    *,
    diarize: bool,
    speaker_count: int,
    language: str,
    progress: Callable[[float, str], None],
) -> dict[str, Any]:
    chunks = _split_pcm(
        pcm,
        min(float(settings.minimax_file_chunk_seconds or MINIMAX_MAX_CHUNK_SECONDS),
            MINIMAX_MAX_CHUNK_SECONDS),
    )
    # Fall back to the operator-configured language hint (same field the
    # realtime MiniMax path honours) so the batch path behaves identically.
    language = language or settings.minimax_language
    sentences: list[dict[str, Any]] = []
    speakers: set[int] = set()
    text_parts: list[str] = []
    warnings: list[str] = []
    global_offset_ms = 0
    speaker_offset = 0
    sentence_id = 0

    if len(chunks) > 1:
        warnings.append("minimax_chunked")

    for idx, chunk in enumerate(chunks):
        wav = _pcm_to_wav(chunk, SAMPLE_RATE)
        payload = await _minimax_post(wav, diarize=diarize, language=language)
        text = (payload.get("text") or "").strip()
        if text:
            text_parts.append(text)

        # Map this chunk's S1/S2/... onto a globally unique integer so the
        # same person does not collide across chunk boundaries. MiniMax has no
        # cross-request speaker identity, so a speaker seen in two chunks is
        # deliberately reported as two ids (the UI lets the user rename/merge).
        local_map: dict[str, int] = {}

        def map_speaker(raw: Any) -> int:
            if not diarize or raw in (None, ""):
                return -1
            key = str(raw)
            if key not in local_map:
                local_map[key] = speaker_offset + len(local_map) + 1
            return local_map[key]

        segments = payload.get("segments") or []
        for seg in segments:
            seg_text = (seg.get("text") or "").strip()
            if not seg_text:
                continue
            speaker_id = map_speaker(seg.get("speaker"))
            if speaker_id >= 0:
                speakers.add(speaker_id)
            begin_ms = int(round(float(seg.get("start") or 0) * 1000)) + global_offset_ms
            end_ms = int(round(float(seg.get("end") or 0) * 1000)) + global_offset_ms
            sentences.append({
                "text": seg_text,
                "begin_ms": max(begin_ms, 0),
                "end_ms": max(end_ms, begin_ms),
                "speaker_id": speaker_id,
                "sentence_id": sentence_id,
            })
            sentence_id += 1

        # No segments (older/short responses) — keep at least the flat text so
        # the transcript is not silently empty.
        if not segments and text:
            begin_ms = global_offset_ms
            end_ms = global_offset_ms + int(len(chunk) / BYTES_PER_SECOND * 1000)
            sentences.append({
                "text": text,
                "begin_ms": begin_ms,
                "end_ms": end_ms,
                "speaker_id": -1,
                "sentence_id": sentence_id,
            })
            sentence_id += 1

        if local_map:
            speaker_offset += len(local_map)

        global_offset_ms += int(len(chunk) / BYTES_PER_SECOND * 1000)
        progress(0.15 + 0.8 * (idx + 1) / len(chunks), "transcribing")

    if diarize and speaker_count and speaker_count >= 2 and len(speakers) > speaker_count:
        warnings.append("more_speakers_than_requested")

    return {
        "text": "\n".join(text_parts),
        "sentences": sentences,
        "speakers": sorted(speakers) if diarize else [],
        "warnings": warnings,
    }


# ── Qwen / DashScope ──────────────────────────────────────────────────────

async def _run_qwen(
    pcm: bytes,
    *,
    diarize: bool,
    speaker_count: int,
    language: str,
    session_id: str,
    progress: Callable[[float, str], None],
) -> dict[str, Any]:
    if diarize:
        return await _run_qwen_diarized(
            pcm, speaker_count=speaker_count, session_id=session_id, progress=progress,
        )
    return await _run_qwen_sync(pcm, language=language, progress=progress)


async def _run_qwen_diarized(
    pcm: bytes,
    *,
    speaker_count: int,
    session_id: str,
    progress: Callable[[float, str], None],
) -> dict[str, Any]:
    """Async paraformer-v2 file transcription with ``diarization_enabled``."""
    if not settings.dashscope_api_key:
        raise RuntimeError("DASHSCOPE_API_KEY is not configured")
    if not settings.oss_configured:
        raise RuntimeError(
            "qwen_diarization_requires_oss: speaker diarization for the Qwen engine needs a "
            "publicly reachable audio URL. Configure OSS (bucket / access key id / secret) "
            "or switch the engine to MiniMax."
        )

    wav = _pcm_to_wav(pcm, SAMPLE_RATE)
    progress(0.25, "uploading_oss")
    loop = asyncio.get_running_loop()
    file_url = await loop.run_in_executor(
        None, upload_wav_to_oss, wav, SAMPLE_RATE, session_id, 0,
    )
    client = DiarizeClient()
    progress(0.4, "submitting")
    task_id = await loop.run_in_executor(
        None,
        lambda: client.submit_chunk(
            file_url=file_url,
            language_hints=settings.language_hints_list(),
            speaker_count=speaker_count or None,
            diarization_enabled=True,
        ),
    )
    progress(0.5, "polling")
    task_data = await loop.run_in_executor(None, client.poll, task_id)
    result_url = client.best_result_url(task_data)
    if not result_url:
        return {"text": "", "sentences": [], "speakers": [], "warnings": ["no_valid_speech"]}
    transcript = await loop.run_in_executor(None, client.fetch_transcript, result_url)
    parsed, speakers = parse_sentences(transcript)
    sentences = [
        {
            "text": s.text,
            "begin_ms": s.begin_ms,
            "end_ms": s.end_ms,
            "speaker_id": s.speaker_id,
            "sentence_id": s.sentence_id,
        }
        for s in parsed
    ]
    progress(0.9, "transcribing")
    return {
        "text": "\n".join(s.text for s in parsed),
        "sentences": sentences,
        "speakers": speakers,
        "warnings": [],
    }


async def _run_qwen_sync(
    pcm: bytes,
    *,
    language: str,
    progress: Callable[[float, str], None],
) -> dict[str, Any]:
    """Sync multimodal-generation transcription (base64 data URL, no diarization)."""
    if not settings.dashscope_api_key:
        raise RuntimeError("DASHSCOPE_API_KEY is not configured")

    duration_sec = len(pcm) / BYTES_PER_SECOND
    if duration_sec > QWEN_SYNC_MAX_SECONDS:
        raise RuntimeError(
            f"qwen_sync_too_long: the Qwen sync endpoint accepts at most "
            f"{QWEN_SYNC_MAX_SECONDS:.0f}s of audio (got {duration_sec:.0f}s). "
            "Use the MiniMax engine, or configure OSS and enable speaker diarization."
        )

    wav = _pcm_to_wav(pcm, SAMPLE_RATE)
    data_url = "data:audio/wav;base64," + base64.b64encode(wav).decode("ascii")
    base = _normalize_base_url(settings.base_url)
    url = f"{base}/api/v1/services/aigc/multimodal-generation/generation"

    body: dict[str, Any] = {
        "model": settings.qwen_file_model,
        "input": {
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "input_audio", "input_audio": {"data": data_url}},
                    ],
                }
            ]
        },
        "parameters": {
            "format": "wav",
            "sample_rate": str(SAMPLE_RATE),
        },
    }
    if language:
        body["parameters"]["asr_options"] = {"language": language}

    headers = {
        "Authorization": f"Bearer {settings.dashscope_api_key}",
        "Content-Type": "application/json",
    }
    progress(0.4, "transcribing")
    async with httpx.AsyncClient(timeout=httpx.Timeout(300.0)) as client:
        resp = await client.post(url, headers=headers, json=body)
    if resp.status_code >= 400:
        raise RuntimeError(f"qwen http {resp.status_code}: {resp.text[:400]}")

    payload = resp.json()
    output = payload.get("output") or {}
    # Documented shape for the ASR multimodal call is
    # ``output.output.sentence.text`` / ``output.text`` (no ``choices``).
    nested = output.get("output") if isinstance(output.get("output"), dict) else {}
    text = (
        (nested.get("sentence") or {}).get("text")
        or output.get("text")
        or ""
    ).strip()

    sentences = []
    if text:
        end_ms = int(duration_sec * 1000)
        sentences.append({
            "text": text,
            "begin_ms": 0,
            "end_ms": end_ms,
            "speaker_id": -1,
            "sentence_id": 0,
        })
    progress(0.9, "transcribing")
    return {
        "text": text,
        "sentences": sentences,
        "speakers": [],
        "warnings": ["qwen_sync_no_diarization"],
    }
