from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _load_dotenv(path: str | os.PathLike[str]) -> None:
    p = Path(path)
    if not p.exists():
        return
    try:
        with p.open("r", encoding="utf-8") as fh:
            for raw in fh:
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
    except OSError:
        # Config file present but unreadable — don't crash startup; storage
        # layer will surface a clearer error when the user tries to save.
        pass


# .env lives in DATA_DIR (not cwd), so secrets never end up in the install
# directory, never get packaged into device updates, and survive across
# re-deploys. Cwd can be anywhere under systemd.
_data_dir_env = Path(os.environ.get("DATA_DIR", "data")).resolve()
_load_dotenv(_data_dir_env / "config.env")


@dataclass
class Settings:
    # NOTE: this is intentionally NOT frozen. It is the single runtime copy of
    # the ASR/analysis configuration that the request handlers actually read
    # (asr_proxy, diarize_*). It is seeded from process env at startup, and is
    # kept in sync with the persisted config.json by Storage._save_config()
    # (storage.py) — see Settings.sync_from() below.
    #
    # History: v0.7.17 incident "DASHSCOPE_API_KEY is not configured" after a
    # hot config push. The class was `frozen=True` with defaults evaluated once
    # at import time, so `update_config()` (which writes config.json +
    # config.env) never refreshed the in-memory object that asr_proxy reads.
    # Result: the key was on disk but the running process kept using the empty
    # startup value. Making it mutable + Storage-backed is the root-cause fix.
    dashscope_api_key: str = os.environ.get("DASHSCOPE_API_KEY", "")
    # DashScope *root* domain — submit/poll code paths already include the
    # `/api/v1/...` segment, so do NOT put a trailing `/v1` here. Operators
    # that paste `https://dashscope.aliyuncs.com/v1` from the console will
    # be normalized by diarize_proxy._normalize_base_url(), but the default
    # below stays clean to keep logs and `config.current` readable.
    base_url: str = os.environ.get(
        "BAILIAN_BASE_URL",
        "https://dashscope.aliyuncs.com",
    )
    asr_model: str = os.environ.get("ASR_MODEL", "paraformer-v2")
    asr_sample_rate: int = int(os.environ.get("ASR_SAMPLE_RATE", "16000"))
    asr_format: str = os.environ.get("ASR_FORMAT", "pcm")
    asr_language_hints: str = os.environ.get("ASR_LANGUAGE_HINTS", "zh,en")
    asr_default_speaker_count: int = int(
        os.environ.get("ASR_DEFAULT_SPEAKER_COUNT", "0")
    )
    asr_chunk_seconds: float = float(os.environ.get("ASR_CHUNK_SECONDS", "12"))
    asr_chunk_overlap_seconds: float = float(
        os.environ.get("ASR_CHUNK_OVERLAP_SECONDS", "2.0")
    )
    asr_poll_interval_seconds: float = float(
        os.environ.get("ASR_POLL_INTERVAL_SECONDS", "0.2")
    )
    # Configurable per-request. Env var sets the ceiling, but the runtime
    # `meeting_max_audio_seconds` field (read from data/config.json) overrides
    # it. Useful for short ad-hoc captures vs long board meetings.
    asr_max_audio_seconds: int = int(os.environ.get("ASR_MAX_AUDIO_SECONDS", "7200"))
    oss_bucket: str = os.environ.get("OSS_BUCKET", "")
    oss_access_key_id: str = os.environ.get("OSS_ACCESS_KEY_ID", "")
    oss_access_key_secret: str = os.environ.get("OSS_ACCESS_KEY_SECRET", "")
    oss_endpoint: str = os.environ.get("OSS_ENDPOINT", "oss-cn-beijing.aliyuncs.com")
    oss_path_prefix: str = os.environ.get("OSS_PATH_PREFIX", "meeting-asr-uploads/")
    paraformer_ws_url: str = os.environ.get(
        "PARAFORMER_WS_URL",
        "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
    )
    paraformer_model: str = os.environ.get("PARAFORMER_MODEL", "paraformer-realtime-v2")
    # Omni-Realtime (multimodal conversation model). The frontend + SDK target
    # `qwen3.8-omni-flash-realtime` (DashScope realtime endpoint), wired via
    # `dashscope.audio.qwen_omni.OmniRealtimeConversation`. The proxy no longer
    # speaks the raw OpenAI-Realtime WS — it drives the SDK and translates
    # the SDK's event stream into the existing frontend protocol. Reuses the
    # same DASHSCOPE_API_KEY as the ASR service — we never expose a per-session
    # key from the client.
    omni_realtime_ws_url: str = os.environ.get(
        "OMNI_REALTIME_WS_URL",
        "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    )
    omni_realtime_model: str = os.environ.get(
        "OMNI_REALTIME_MODEL",
        "qwen3.8-omni-flash-realtime",
    )
    omni_realtime_voice: str = os.environ.get(
        "OMNI_REALTIME_VOICE",
        # Verified against qwen3.8-omni-flash-realtime with a complete
        # text-to-speech turn. Ethan is rejected by this model.
        "Tina",
    )
    omni_realtime_instructions: str = os.environ.get(
        "OMNI_REALTIME_INSTRUCTIONS",
        "",
    )
    # Per Qwen-Omni-Realtime docs the audio.input.format / audio.output.format
    # `sample_rate` is one of 8000/16000/24000/48000. Defaults match the docs:
    # 16 kHz on input (mic capture rate), 24 kHz on output (TTS rate). Operators
    # can override via env when a specific device profile demands a different
    # rate, but the proxy must keep client + server in lock-step.
    omni_realtime_input_sample_rate: int = int(
        os.environ.get("OMNI_REALTIME_INPUT_SAMPLE_RATE", "16000")
    )
    omni_realtime_output_sample_rate: int = int(
        os.environ.get("OMNI_REALTIME_OUTPUT_SAMPLE_RATE", "24000")
    )
    # Optional WorkspaceId for region-routed WSS endpoints. The docs give
    # `wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime`;
    # operators that need that route instead of the international
    # `wss://dashscope.aliyuncs.com/api-ws/v1/realtime` can set
    # OMNI_REALTIME_WORKSPACE_ID. When unset we use the bare international
    # URL above (which already routes to Beijing when the API key was issued
    # there).
    omni_realtime_workspace_id: str = os.environ.get(
        "OMNI_REALTIME_WORKSPACE_ID", ""
    )
    # `enable_search` per the Bailian docs is opt-in. The proxy wires it on
    # only when (a) the operator opts in via env, AND (b) no tools are
    # declared for the session — tool calling and web search are mutually
    # exclusive per the docs.
    omni_realtime_enable_search: bool = os.environ.get(
        "OMNI_REALTIME_ENABLE_SEARCH", "false"
    ).lower() in ("true", "1", "yes")
    paraformer_format: str = os.environ.get("PARAFORMER_FORMAT", "pcm")
    paraformer_sample_rate: int = int(os.environ.get("PARAFORMER_SAMPLE_RATE", "16000"))
    paraformer_semantic_punctuation: bool = os.environ.get(
        "PARAFORMER_SEMANTIC_PUNCTUATION", "true"
    ).lower() in ("true", "1", "yes")
    host: str = os.environ.get("BACKEND_HOST", "127.0.0.1")
    port: int = int(os.environ.get("BACKEND_PORT", "8000"))
    cors_origin: str = os.environ.get("CORS_ORIGIN", "http://localhost:5173")
    # ------------------------------------------------------------------
    # ASR provider selection. `'dashscope'` (default) keeps the existing
    # Paraformer WebSocket flow; `'minimax'` switches the frontend WebSocket
    # in `asr_proxy.py` to the MiniMax REST chunking flow (see
    # `asr_minimax.py`).
    # ------------------------------------------------------------------
    asr_provider: str = os.environ.get("ASR_PROVIDER", "dashscope")
    # MiniMax provider env defaults — only consumed when `asr_provider` is
    # `'minimax'`. Mirrors the DashScope fields above.
    minimax_api_key: str = os.environ.get("MINIMAX_API_KEY", "")
    minimax_asr_model: str = os.environ.get("MINIMAX_ASR_MODEL", "asr-1.0")
    minimax_base_url: str = os.environ.get("MINIMAX_BASE_URL", "https://api.minimaxi.com")
    minimax_language: str = os.environ.get("MINIMAX_LANGUAGE", "")
    minimax_audio_format: str = os.environ.get("MINIMAX_AUDIO_FORMAT", "wav")
    minimax_sample_rate: int = int(os.environ.get("MINIMAX_SAMPLE_RATE", "16000"))
    minimax_chunk_seconds: float = float(os.environ.get("MINIMAX_CHUNK_SECONDS", "12.0"))
    # ------------------------------------------------------------------
    # Whole-file (batch) transcription — see `file_transcribe.py`.
    # `qwen_file_model` is the DashScope model used by the synchronous
    # base64 data-URL path (no OSS). The diarized Qwen path reuses
    # `asr_model` (default paraformer-v2) through the async file API.
    # ------------------------------------------------------------------
    qwen_file_model: str = os.environ.get("QWEN_FILE_MODEL", "qwen-audio-3.0-asr-flash")
    # MiniMax caps one request at 500 s; the batch path splits longer audio
    # into windows of this size (with a safety margin).
    minimax_file_chunk_seconds: float = float(
        os.environ.get("MINIMAX_FILE_CHUNK_SECONDS", "480")
    )

    def sync_from(self, asr: object) -> None:
        """Refresh the fields that a hot config push (Storage.update_config)
        may have changed.

        `asr` is the runtime ASRConfig pydantic model from storage. Only the
        fields that Storage actually persists are copied — anything that is
        purely process-env (host/port/cors, OSS credentials, chunking knobs)
        stays untouched because those are spawn-time decisions by the Node
        parent and cannot be changed without a restart anyway.

        Called by Storage._save_config() after every write, so disk
        (config.json + config.env), Storage._config, and this object always
        agree. Without this the handlers read stale secrets after the user
        edits the key in the Web UI.
        """
        if asr is None:
            return
        self.dashscope_api_key = asr.dashscope_api_key
        self.paraformer_ws_url = asr.paraformer_ws_url
        self.paraformer_model = asr.paraformer_model
        self.paraformer_format = asr.paraformer_format
        self.paraformer_sample_rate = int(asr.paraformer_sample_rate)
        self.paraformer_semantic_punctuation = bool(asr.paraformer_semantic_punctuation)
        # language hints live under the ASR section too; keep both spellings
        # in sync so callers that read either name see the same value.
        if getattr(asr, "paraformer_language_hints", None):
            self.asr_language_hints = asr.paraformer_language_hints
        # MiniMax provider fields — only sync when the config explicitly
        # provides them (older configs / hot-restart upgrades may not).
        if getattr(asr, "minimax_api_key", None):
            self.minimax_api_key = asr.minimax_api_key
        if getattr(asr, "minimax_asr_model", None):
            self.minimax_asr_model = asr.minimax_asr_model
        if getattr(asr, "minimax_base_url", None):
            self.minimax_base_url = asr.minimax_base_url
        if getattr(asr, "minimax_language", None) is not None:
            self.minimax_language = asr.minimax_language
        if getattr(asr, "minimax_audio_format", None):
            self.minimax_audio_format = asr.minimax_audio_format
        if getattr(asr, "minimax_sample_rate", None):
            self.minimax_sample_rate = int(asr.minimax_sample_rate)
        if getattr(asr, "minimax_chunk_seconds", None):
            self.minimax_chunk_seconds = float(asr.minimax_chunk_seconds)

    def language_hints_list(self) -> list[str]:
        return [s.strip() for s in self.asr_language_hints.split(",") if s.strip()]

    @property
    def is_minimax_provider(self) -> bool:
        return (self.asr_provider or "dashscope").lower() == "minimax"

    @property
    def minimax_configured(self) -> bool:
        return bool(self.minimax_api_key and self.minimax_base_url)

    @property
    def oss_configured(self) -> bool:
        return bool(self.oss_bucket and self.oss_access_key_id and self.oss_access_key_secret)


settings = Settings()
