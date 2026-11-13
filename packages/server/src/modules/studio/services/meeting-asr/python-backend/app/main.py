from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import time
from contextlib import asynccontextmanager

# Fix DNS resolution inside uvicorn on Windows (ProactorEventLoop + run_in_executor issue)
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from sse_starlette.sse import EventSourceResponse

from .asr_proxy import ParaformerProxy
from .asr_minimax import MiniMaxProxy
from .config import settings
from .file_transcribe import get_job as get_transcribe_job, start_transcription
from .omni_realtime_proxy import FunctionCallGate, OmniRealtimeProxy, translate_event as translate_omni_event
from ._log_helper import log_skip
from .html_generator import generate_html_report
from .llm_service import llm_service
from .models import (
    AllConfig, ASRConfig, LLMConfig, AnalysisConfig,
    AnalysisRequest, AnalysisResult, AnalysisStatus, DEFAULT_PROMPTS,
)
from .storage import storage

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("main")

# Capability marker for the whole-file transcription endpoints. The Web UI
# ships the same value and compares it against /healthz: a long-lived uvicorn
# child keeps the Python modules it imported at spawn time, so after a code
# update (rebuild dist + refresh the browser) it can still be running stale
# logic. Detecting the mismatch lets the client restart the service instead of
# failing mid-request. Bump this whenever the /api/transcribe contract changes.
TRANSCRIBE_CAPABILITY = "2"

_analysis_task: asyncio.Task | None = None
_analysis_running = False


@asynccontextmanager
async def lifespan(_app: FastAPI):
    config = storage.get_config()
    log.info("backend ready, asr_model=%s llm_model=%s", config.asr.paraformer_model, config.llm.model)
    yield
    global _analysis_task
    if _analysis_task and not _analysis_task.done():
        _analysis_task.cancel()
        try:
            await _analysis_task
        except (asyncio.CancelledError, Exception):
            pass


app = FastAPI(title="Meeting ASR Cloud Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.cors_origin, "http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/healthz")
async def healthz() -> dict:
    config = storage.get_config()
    return {
        "status": "ok",
        "asr_model": config.asr.paraformer_model,
        "llm_model": config.llm.model,
        # See TRANSCRIBE_CAPABILITY: the client uses these two fields to decide
        # whether the running process is stale and needs a restart.
        "transcribe": TRANSCRIBE_CAPABILITY,
        "code_hash": os.environ.get("MEETING_ASR_CODE_HASH", ""),
    }


@app.get("/api/config")
async def get_all_config() -> dict:
    return storage.get_config_safe()


@app.post("/api/config")
async def update_all_config(config: AllConfig) -> dict:
    storage.update_config(config)
    return {"status": "ok", "message": "配置已保存"}


@app.get("/api/config/asr")
async def get_asr_config() -> ASRConfig:
    return storage.get_config().asr


@app.post("/api/config/asr")
async def update_asr_config(config: ASRConfig) -> dict:
    storage.update_asr_config(config)
    return {"status": "ok", "message": "ASR配置已保存"}


@app.get("/api/config/llm")
async def get_llm_config() -> dict:
    data = storage.get_config().llm.model_dump()
    key = data.get("api_key", "")
    data["api_key_masked"] = key[:8] + "****" + key[-4:] if len(key) > 12 else ("****" if key else "")
    return data


@app.post("/api/config/llm")
async def update_llm_config(config: LLMConfig) -> dict:
    storage.update_llm_config(config)
    return {"status": "ok", "message": "LLM配置已保存"}


@app.get("/api/config/analysis")
async def get_analysis_config() -> AnalysisConfig:
    return storage.get_config().analysis


@app.post("/api/config/analysis")
async def update_analysis_config(config: AnalysisConfig) -> dict:
    storage.update_analysis_config(config)
    return {"status": "ok", "message": "分析配置已保存"}


@app.get("/api/prompts")
async def get_prompts() -> dict:
    return {
        name: {"name": p.name, "description": p.description, "template": p.template}
        for name, p in DEFAULT_PROMPTS.items()
    }


@app.get("/api/analysis/status")
async def get_analysis_status() -> AnalysisStatus:
    return storage.get_status()


@app.get("/api/analysis/result")
async def get_analysis_result() -> AnalysisResult | None:
    return storage.get_analysis()


@app.get("/api/analysis/html")
async def get_analysis_html() -> HTMLResponse:
    analysis = storage.get_analysis()
    if not analysis or not analysis.html_content:
        return HTMLResponse(
            content="<html><body><h1>暂无分析结果</h1><p>请先启动分析并等待生成。</p></body></html>",
            status_code=200,
        )
    return HTMLResponse(content=analysis.html_content, status_code=200)


@app.post("/api/analysis/start")
async def start_analysis(request: AnalysisRequest) -> dict:
    global _analysis_task, _analysis_running

    if _analysis_running:
        return {"status": "already_running", "message": "分析已在运行中"}

    _analysis_running = True

    # 更新配置
    config = storage.get_config()
    config.analysis.trigger_mode = request.trigger_mode
    config.analysis.interval_sentences = request.interval_sentences
    config.analysis.interval_seconds = request.interval_seconds
    storage.update_config(config)

    storage.update_status(is_running=True, current_interval=request.interval_seconds)

    async def analysis_loop():
        global _analysis_running
        while _analysis_running:
            try:
                should_analyze = False
                current_config = storage.get_config().analysis

                # 基于句子数量触发
                if current_config.trigger_mode in ("sentences", "both"):
                    if llm_service._should_analyze_by_sentences(current_config.interval_sentences):
                        should_analyze = True

                # 基于时间间隔触发
                if current_config.trigger_mode in ("time", "both"):
                    should_analyze = True

                if should_analyze:
                    result = await llm_service.run_analysis_cycle(request.custom_prompt)
                    if result:
                        llm_service._mark_analyzed()
                        log.info("Analysis completed: %s", result.summary[:50] if result.summary else "no summary")

            except Exception as e:
                log.error("Analysis loop error: %s", e)

            # 检查间隔：句子模式下检查更频繁
            check_interval = 5 if current_config.trigger_mode == "sentences" else current_config.interval_seconds
            await asyncio.sleep(check_interval)

    _analysis_task = asyncio.create_task(analysis_loop())
    return {"status": "started", "interval": request.interval_seconds}


@app.post("/api/analysis/stop")
async def stop_analysis() -> dict:
    global _analysis_task, _analysis_running

    _analysis_running = False
    if _analysis_task and not _analysis_task.done():
        _analysis_task.cancel()
        try:
            await _analysis_task
        except (asyncio.CancelledError, Exception):
            pass

    storage.update_status(is_running=False)
    return {"status": "stopped"}


@app.post("/api/analysis/trigger")
async def trigger_analysis() -> dict:
    try:
        result = await llm_service.run_analysis_cycle()
        if result:
            return {
                "status": "ok",
                "summary": result.summary,
                "should_update_html": result.should_update_html,
            }
        return {"status": "skipped", "message": "无显著变化，跳过分析"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.get("/api/analysis/stream")
async def analysis_stream():
    async def event_generator():
        last_update = 0.0
        while True:
            status = storage.get_status()
            analysis = storage.get_analysis()

            if analysis and analysis.timestamp > last_update:
                last_update = analysis.timestamp
                yield {
                    "event": "update",
                    "data": json.dumps({
                        "summary": analysis.summary,
                        "key_points": analysis.key_points,
                        "action_items": analysis.action_items,
                        "people_count": len(analysis.people_mentioned),
                        "topics": analysis.topics,
                        "timestamp": analysis.timestamp,
                        "has_html": analysis.html_content is not None,
                    }, ensure_ascii=False),
                }

            yield {
                "event": "status",
                "data": json.dumps({
                    "is_running": status.is_running,
                    "total_analyses": status.total_analyses,
                    "error": status.error,
                }, ensure_ascii=False),
            }

            await asyncio.sleep(2)

    return EventSourceResponse(event_generator())


@app.post("/api/transcript")
async def add_transcript(data: dict) -> dict:
    text = data.get("text", "")
    if text:
        llm_service.add_transcript(text)
    return {"status": "ok"}


@app.post("/api/transcript/sentence")
async def add_sentence(data: dict) -> dict:
    """添加单个句子到缓冲区"""
    sentence = data.get("sentence", "")
    if sentence:
        llm_service.add_sentence(sentence)
    return {"status": "ok", "sentence_count": llm_service.get_sentence_count()}


@app.get("/api/transcript/sentence/count")
async def get_sentence_count() -> dict:
    """获取当前句子数量"""
    return {"count": llm_service.get_sentence_count()}


@app.get("/api/transcript")
async def get_transcript() -> dict:
    return {"transcript": llm_service.get_transcript()}


@app.post("/api/transcript/clear")
async def clear_transcript() -> dict:
    llm_service.clear_transcript()
    storage.clear_analysis()
    return {"status": "ok"}


# ── Whole-file transcription (batch) ─────────────────────────────────────
# Used by the "split speakers after recording" button and by the
# "direct audio transcription" tab of the create-meeting dialog. The audio
# body is the raw container bytes (webm/mp3/wav/...); ffmpeg decodes it in
# the background job. Long transcriptions are polled through
# /api/transcribe/status/{job_id} instead of holding the HTTP request open.


def _truthy(raw: str | None) -> bool:
    return str(raw or "").strip().lower() in ("1", "true", "yes", "on")


@app.post("/api/transcribe/file")
async def start_file_transcription(
    request: Request,
    engine: str = "minimax",
    diarize: str = "false",
    speaker_count: str = "0",
    language: str = "",
    session_id: str = "",
) -> dict:
    body = await request.body()
    try:
        count = int(speaker_count or 0)
    except (TypeError, ValueError):
        count = 0
    try:
        job_id = start_transcription(
            body,
            engine=engine,
            diarize=_truthy(diarize),
            speaker_count=count,
            language=language,
            session_id=session_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"job_id": job_id, "status": "pending"}


@app.get("/api/transcribe/status/{job_id}")
async def get_file_transcription_status(job_id: str) -> dict:
    job = get_transcribe_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="transcription job not found")
    return job


@app.websocket("/ws/asr")
async def ws_asr(ws: WebSocket) -> None:
    """Bridge the frontend WS to either DashScope Paraformer (default) or the
    MiniMax REST provider. Routing is decided at connect time from the
    `provider` field on the start frame, falling back to the global
    `settings.asr_provider` so operators can switch providers via env
    (`ASR_PROVIDER=minimax`) without touching the client.
    """
    await ws.accept()
    proxy: ParaformerProxy | MiniMaxProxy | None = None
    upstream_task: asyncio.Task | None = None
    closed = False

    try:
        first = await ws.receive()
        if "text" not in first:
            await ws.send_json({"type": "error", "message": "expected start frame"})
            await ws.close()
            return

        try:
            start_msg = json.loads(first["text"])
        except json.JSONDecodeError:
            await ws.send_json({"type": "error", "message": "invalid start frame json"})
            await ws.close()
            return

        if start_msg.get("type") != "start":
            await ws.send_json({"type": "error", "message": "first frame must be {\"type\":\"start\"}"})
            await ws.close()
            return

        # Provider selection precedence:
        #   1. `provider` field on the WS start frame (per-session override)
        #   2. `settings.asr_provider` (env / hot config push)
        #   3. DashScope (default, backward-compatible)
        requested_provider = str(start_msg.get("provider") or "").strip().lower()
        if requested_provider == "minimax" or (
            not requested_provider and settings.is_minimax_provider
        ):
            proxy = MiniMaxProxy()
        else:
            proxy = ParaformerProxy()

        await proxy.connect()
        await ws.send_json({"type": "ready", "task_id": proxy.task_id, "provider": "minimax" if isinstance(proxy, MiniMaxProxy) else "dashscope"})

        async def pump_upstream() -> None:
            try:
                async for event in proxy.upstream_events():
                    # MiniMax emits a flatter dict (`{type, text, ...}`);
                    # DashScope wraps events in `{header, payload}`. Branch on
                    # presence of `header` so both providers share the same
                    # pump without leaking upstream-specific shapes.
                    if "header" in event:
                        header = event.get("header", {})
                        name = header.get("event")
                        payload = event.get("payload", {}) or {}
                        sentence = (payload.get("output") or {}).get("sentence") or {}
                        try:
                            if name == "result-generated":
                                text = sentence.get("text", "")
                                if sentence.get("heartbeat"):
                                    continue
                                is_final = bool(sentence.get("sentence_end"))
                                await ws.send_json({
                                    "type": "partial" if not is_final else "final",
                                    "text": text,
                                    "begin_time": sentence.get("begin_time"),
                                    "end_time": sentence.get("end_time"),
                                    "sentence_end": is_final,
                                    "usage": payload.get("usage"),
                                })
                                if is_final and text:
                                    llm_service.add_transcript(text)
                            elif name == "task-started":
                                await ws.send_json({"type": "started"})
                            elif name == "task-finished":
                                await ws.send_json({"type": "stopped"})
                            elif name == "task-failed":
                                await ws.send_json({
                                    "type": "error",
                                    "code": header.get("error_code"),
                                    "message": header.get("error_message"),
                                })
                        except (WebSocketDisconnect, RuntimeError):
                            return
                        except Exception as exc:
                            log.warning("upstream send failed: %s", exc)
                            return
                    else:
                        # MiniMax-style flat event.
                        mtype = event.get("type")
                        try:
                            if mtype == "final":
                                text = event.get("text", "")
                                await ws.send_json({
                                    "type": "final",
                                    "text": text,
                                    "begin_time": event.get("begin_time"),
                                    "end_time": event.get("end_time"),
                                    "usage": event.get("usage"),
                                })
                                if text:
                                    llm_service.add_transcript(text)
                            elif mtype == "stopped":
                                await ws.send_json({"type": "stopped"})
                            elif mtype == "error":
                                await ws.send_json({
                                    "type": "error",
                                    "message": event.get("message"),
                                })
                        except (WebSocketDisconnect, RuntimeError):
                            return
                        except Exception as exc:
                            log.warning("minimax upstream send failed: %s", exc)
                            return
            except Exception as exc:
                log.exception("upstream pump error: %s", exc)

        upstream_task = asyncio.create_task(pump_upstream())

        while not closed:
            try:
                frame = await ws.receive()
            except (WebSocketDisconnect, RuntimeError):
                break
            if "bytes" in frame:
                data = frame["bytes"]
                if data:
                    try:
                        await proxy.send_audio(data)
                    except Exception as exc:
                        log.exception("send_audio failed: %s", exc)
                        try:
                            await ws.send_json({"type": "error", "message": f"upstream send: {exc}"})
                        except Exception as exc:
                            log_skip("asr_error_send", exc)
                            break
            elif "text" in frame:
                try:
                    msg = json.loads(frame["text"])
                except json.JSONDecodeError:
                    continue
                mtype = msg.get("type")
                if mtype == "stop":
                    await proxy.finish()
                elif mtype == "ping":
                    await ws.send_json({"type": "pong"})

    except WebSocketDisconnect:
        log.info("client disconnected")
    except Exception as exc:
        log.exception("ws_asr error: %s", exc)
        try:
            await ws.send_json({"type": "error", "message": str(exc)})
        except Exception as send_exc:
            log_skip("asr_top_error_send", send_exc)
    finally:
        if upstream_task is not None:
            upstream_task.cancel()
            try:
                await upstream_task
            except (asyncio.CancelledError, Exception):
                pass
        if proxy is not None:
            await proxy.close()


@app.websocket("/ws/omni-realtime")
async def ws_omni_realtime(ws: WebSocket) -> None:
    """Bridge a frontend WS to the DashScope Omni-Realtime API.

    Wire format is documented in ``omni_realtime_proxy.py``. The handler is
    intentionally thin — all the protocol translation lives in the proxy
    module so it stays unit-testable.
    """
    await ws.accept()
    proxy: OmniRealtimeProxy | None = None
    upstream_task: asyncio.Task | None = None
    # DashScope announces one model tool call up to twice
    # (`conversation.item.created` + `response.function_call_arguments.done`) and
    # the bookkeeping copy can arrive FIRST with EMPTY `arguments` while the
    # model is still filling them in. A naive first-wins dedupe by call_id would
    # forward the empty copy and throw the real one away — the client then
    # executes the tool with `{}` and, for tools with required arguments
    # (`query_hermes_agent.question`), the error feeds an endless retry loop of
    # identical empty calls (the `query_hermes_agent {}` storm). `call_gate`
    # parks empty-arguments announcements until the arguments-bearing copy
    # arrives (forwarded immediately) or the response boundary forces a flush
    # (legitimately argument-less tools such as `list_jobs` still execute).
    call_gate = FunctionCallGate()
    gate_boundary_types = ("response_done", "error")

    async def pump_upstream() -> None:
        if proxy is None:
            return
        try:
            async for raw in proxy.upstream_events():
                translated = translate_omni_event(raw)
                if translated is None:
                    continue
                if isinstance(translated, str):
                    try:
                        evt = json.loads(translated)
                    except json.JSONDecodeError:
                        evt = None
                    if isinstance(evt, dict):
                        evt_type = evt.get("type")
                        if evt_type == "function_call":
                            decided = call_gate.on_function_call(
                                str(evt.get("call_id") or ""),
                                str(evt.get("arguments") or "{}"),
                                translated,
                            )
                            if decided is None:
                                continue
                            translated = decided
                        elif evt_type in gate_boundary_types:
                            # The response finished (or errored): no richer
                            # arguments copy is coming for parked announcements —
                            # release them before the boundary frame so the client
                            # sees function_call → response_done in natural order.
                            for parked in call_gate.flush():
                                try:
                                    await ws.send_text(parked)
                                except (WebSocketDisconnect, RuntimeError):
                                    return
                                except Exception as exc:
                                    log.warning(
                                        "omni-realtime: downstream send failed: %s",
                                        exc,
                                    )
                                    return
                try:
                    if isinstance(translated, (bytes, bytearray)):
                        await ws.send_bytes(bytes(translated))
                    else:
                        await ws.send_text(translated)
                except (WebSocketDisconnect, RuntimeError):
                    return
                except Exception as exc:
                    log.warning("omni-realtime: downstream send failed: %s", exc)
                    return
        except Exception as exc:
            log.exception("omni-realtime: upstream pump error: %s", exc)

    try:
        first = await ws.receive()
        if "text" not in first:
            await ws.send_json({"type": "error", "message": "expected start frame"})
            await ws.close()
            return

        try:
            start_msg = json.loads(first["text"])
        except json.JSONDecodeError:
            await ws.send_json({"type": "error", "message": "invalid start frame json"})
            await ws.close()
            return

        if start_msg.get("type") != "start":
            await ws.send_json({"type": "error", "message": "first frame must be {\"type\":\"start\"}"})
            await ws.close()
            return

        proxy = OmniRealtimeProxy(
            model=start_msg.get("model"),
            voice=start_msg.get("voice"),
            instructions=start_msg.get("instructions"),
            tools=start_msg.get("tools"),
            turn_silence_ms=450 if start_msg.get("client") == "xiaozhi" else 800,
        )
        await proxy.connect()
        await ws.send_json({
            "type": "ready", "session_id": proxy.session_id, "model": proxy.model,
            "input_audio": {"format": "pcm_s16le", "sample_rate": 16000, "channels": 1},
            "output_audio": {"format": "pcm_s16le", "sample_rate": 24000, "channels": 1},
            "turn_silence_ms": proxy.turn_silence_ms,
        })

        upstream_task = asyncio.create_task(pump_upstream())

        while True:
            try:
                frame = await ws.receive()
            except (WebSocketDisconnect, RuntimeError):
                break

            if "bytes" in frame:
                data = frame["bytes"]
                if not data:
                    continue
                try:
                    await proxy.send_audio(data)
                except Exception as exc:
                    log.warning("omni-realtime: send_audio failed: %s", exc)
                    try:
                        await ws.send_json({"type": "error", "message": f"upstream send: {exc}"})
                    except Exception:
                        break
            elif "text" in frame:
                try:
                    msg = json.loads(frame["text"])
                except json.JSONDecodeError:
                    continue
                mtype = msg.get("type")
                if mtype == "commit":
                    await proxy.commit_audio()
                elif mtype == "cancel":
                    await proxy.cancel()
                elif mtype == "image":
                    await proxy.send_image(str(msg.get("image") or ""))
                elif mtype == "tool_result":
                    await proxy.send_tool_output(
                        str(msg.get("call_id") or ""),
                        str(msg.get("output") or ""),
                    )
                elif mtype == "text":
                    # 同会话文本注入（口语对练收尾总评等）：模型基于本会话已
                    # 看到/听到的上下文直接作答，无需另开离线全模态请求。
                    await proxy.send_text(str(msg.get("text") or ""))
                elif mtype == "ping":
                    try:
                        await ws.send_json({"type": "pong"})
                    except Exception:
                        break
                elif mtype == "stop":
                    await proxy.commit_audio()
                    break
    except WebSocketDisconnect:
        log.info("omni-realtime: client disconnected")
    except Exception as exc:
        log.exception("ws_omni_realtime error: %s", exc)
        try:
            await ws.send_json({"type": "error", "message": str(exc)})
        except Exception:
            pass
    finally:
        if upstream_task is not None:
            upstream_task.cancel()
            try:
                await upstream_task
            except (asyncio.CancelledError, Exception):
                pass
        if proxy is not None:
            await proxy.close()
        try:
            await ws.send_json({"type": "stopped"})
        except Exception:
            pass


def main() -> None:
    import uvicorn

    # Fix DNS resolution inside uvicorn on Windows (ProactorEventLoop + run_in_executor issue)
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=False,
        log_level="info",
    )


if __name__ == "__main__":
    main()
