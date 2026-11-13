"""Standalone speaker-diarization server.

Runs on its own port (default 8001) so it stays decoupled from any process
that may be editing the main realtime-ASR app (e.g. an external agent
maintaining `app/main.py`).

Frontend connects to ws://localhost:8001/ws/diarize for speaker-diarized
transcription. Other realtime endpoints can live elsewhere.
"""
from __future__ import annotations

import asyncio
import logging
import os
import sys
from contextlib import asynccontextmanager

# Fix DNS resolution inside uvicorn on Windows (ProactorEventLoop + run_in_executor issue)
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .diarize_endpoint import diarize_ws_handler
from .diarize_proxy import cleanup_session_files

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("diarize_server")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    log.info(
        "diarize server ready, model=%s base=%s oss=%s",
        settings.asr_model,
        settings.base_url,
        "ok" if settings.oss_configured else "MISSING",
    )
    yield


app = FastAPI(title="Meeting ASR Diarize Server", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        settings.cors_origin,
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {
        "status": "ok",
        "service": "diarize",
        "model": settings.asr_model,
        "oss": "ok" if settings.oss_configured else "missing",
        "chunk_seconds": str(settings.asr_chunk_seconds),
        "overlap_seconds": str(settings.asr_chunk_overlap_seconds),
    }


@app.post("/api/cleanup/{session_id}")
async def cleanup_session(session_id: str) -> dict[str, int]:
    """Manually cleanup OSS files for a given session."""
    loop = asyncio.get_running_loop()
    deleted_count = await loop.run_in_executor(None, cleanup_session_files, session_id)
    return {"deleted_count": deleted_count}


@app.websocket("/ws/diarize")
async def ws_diarize(ws: WebSocket) -> None:
    await diarize_ws_handler(ws)


def main() -> None:
    import uvicorn

    # Fix DNS resolution inside uvicorn on Windows (ProactorEventLoop + run_in_executor issue)
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

    uvicorn.run(
        "app.diarize_server:app",
        host=settings.host,
        port=int(os.environ.get("DIARIZE_PORT", "8001")),
        reload=False,
        log_level="info",
    )


if __name__ == "__main__":
    main()