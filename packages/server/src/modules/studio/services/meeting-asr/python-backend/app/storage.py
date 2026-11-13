from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path

from .models import AllConfig, AnalysisResult, AnalysisStatus, ASRConfig, LLMConfig, AnalysisConfig
from .config import settings

log = logging.getLogger("storage")

DATA_DIR = Path(os.environ.get("DATA_DIR", "data"))
CONFIG_FILE = DATA_DIR / "config.json"
ANALYSIS_FILE = DATA_DIR / "analysis.json"
STATUS_FILE = DATA_DIR / "status.json"
# .env lives in DATA_DIR (not cwd/install dir) so secrets don't leak into the
# install directory or get packaged into device upgrade bundles.
ENV_FILE = DATA_DIR / "config.env"


def _ensure_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


class Storage:
    def __init__(self) -> None:
        _ensure_dir()
        self._config = self._load_config()
        self._analysis_result = self._load_analysis()
        self._status = self._load_status()

    def _load_config(self) -> AllConfig:
        # Env-var defaults — used when config.json is missing or when a
        # specific field is absent from the file.  This keeps settings in sync
        # with the env vars that the Node.js parent passed at spawn time,
        # so the /api/config endpoint reflects the same key that the frozen
        # `settings` object (config.py) is actually using for API calls.
        env_asr = ASRConfig(
            dashscope_api_key=os.environ.get("DASHSCOPE_API_KEY", ""),
            paraformer_ws_url=os.environ.get("PARAFORMER_WS_URL", "wss://dashscope.aliyuncs.com/api-ws/v1/inference"),
            paraformer_model=os.environ.get("PARAFORMER_MODEL", "paraformer-realtime-v2"),
            paraformer_sample_rate=int(os.environ.get("PARAFORMER_SAMPLE_RATE", "16000")),
            paraformer_format=os.environ.get("PARAFORMER_FORMAT", "pcm"),
            paraformer_language_hints=os.environ.get("PARAFORMER_LANGUAGE_HINTS", "zh,en"),
            paraformer_semantic_punctuation=os.environ.get("PARAFORMER_SEMANTIC_PUNCTUATION", "true").lower() in ("true", "1", "yes"),
            minimax_api_key=os.environ.get("MINIMAX_API_KEY", ""),
            minimax_asr_model=os.environ.get("MINIMAX_ASR_MODEL", "asr-1.0"),
            minimax_base_url=os.environ.get("MINIMAX_BASE_URL", "https://api.minimaxi.com"),
            minimax_language=os.environ.get("MINIMAX_LANGUAGE", ""),
            minimax_audio_format=os.environ.get("MINIMAX_AUDIO_FORMAT", "wav"),
            minimax_sample_rate=int(os.environ.get("MINIMAX_SAMPLE_RATE", "16000")),
            minimax_chunk_seconds=float(os.environ.get("MINIMAX_CHUNK_SECONDS", "12.0")),
        )
        if CONFIG_FILE.exists():
            try:
                data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
                # Deep-merge: env-var defaults fill in any field that config.json
                # doesn't explicitly provide.  This is critical because Node.js
                # `updateLLMConfig` writes only the `llm` section — without this
                # fallback the `asr` section would silently default to empty.
                file_asr_data = data.get("asr", {})
                merged_asr = ASRConfig(
                    dashscope_api_key=file_asr_data.get("dashscope_api_key") or env_asr.dashscope_api_key,
                    paraformer_ws_url=file_asr_data.get("paraformer_ws_url") or env_asr.paraformer_ws_url,
                    paraformer_model=file_asr_data.get("paraformer_model") or env_asr.paraformer_model,
                    paraformer_sample_rate=int(file_asr_data.get("paraformer_sample_rate") or env_asr.paraformer_sample_rate),
                    paraformer_format=file_asr_data.get("paraformer_format") or env_asr.paraformer_format,
                    paraformer_language_hints=file_asr_data.get("paraformer_language_hints") or env_asr.paraformer_language_hints,
                    paraformer_semantic_punctuation=(
                        file_asr_data.get("paraformer_semantic_punctuation")
                        if file_asr_data.get("paraformer_semantic_punctuation") is not None
                        else env_asr.paraformer_semantic_punctuation
                    ),
                    minimax_api_key=file_asr_data.get("minimax_api_key") or env_asr.minimax_api_key,
                    minimax_asr_model=file_asr_data.get("minimax_asr_model") or env_asr.minimax_asr_model,
                    minimax_base_url=file_asr_data.get("minimax_base_url") or env_asr.minimax_base_url,
                    minimax_language=file_asr_data.get("minimax_language", env_asr.minimax_language),
                    minimax_audio_format=file_asr_data.get("minimax_audio_format") or env_asr.minimax_audio_format,
                    minimax_sample_rate=int(file_asr_data.get("minimax_sample_rate") or env_asr.minimax_sample_rate),
                    minimax_chunk_seconds=float(file_asr_data.get("minimax_chunk_seconds") or env_asr.minimax_chunk_seconds),
                )
                return AllConfig(
                    asr=merged_asr,
                    llm=LLMConfig(**data.get("llm", {})),
                    analysis=AnalysisConfig(**data.get("analysis", {})),
                )
            except Exception as e:
                log.warning("Failed to load config: %s", e)
        return AllConfig(asr=env_asr, llm=LLMConfig(), analysis=AnalysisConfig())

    def _save_config(self) -> None:
        try:
            CONFIG_FILE.write_text(
                self._config.model_dump_json(indent=2),
                encoding="utf-8",
            )
            self._save_to_env()
        except Exception as e:
            log.error("Failed to save config: %s", e)
        finally:
            # Keep the runtime Settings object (what asr_proxy / diarize_*
            # actually read) in lockstep with what was just persisted. Without
            # this, a hot config push writes the new key to disk + config.env
            # but the handlers keep using the process-start value, surfacing
            # "DASHSCOPE_API_KEY is not configured" after the user edits the
            # key in the Web UI (v0.7.17 incident). Always runs — even if the
            # disk write failed, the in-memory source of truth is still the
            # merged config the caller intended to save.
            settings.sync_from(self._config.asr)

    def _save_to_env(self) -> None:
        try:
            env_lines = []
            if ENV_FILE.exists():
                with open(ENV_FILE, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith("#") and "=" in line:
                            key = line.split("=")[0].strip()
                            if key not in [
                                "DASHSCOPE_API_KEY",
                                "PARAFORMER_WS_URL",
                                "PARAFORMER_MODEL",
                                "PARAFORMER_SAMPLE_RATE",
                                "PARAFORMER_FORMAT",
                                "PARAFORMER_LANGUAGE_HINTS",
                                "PARAFORMER_SEMANTIC_PUNCTUATION",
                                "MINIMAX_API_KEY",
                                "MINIMAX_ASR_MODEL",
                                "MINIMAX_BASE_URL",
                                "MINIMAX_LANGUAGE",
                                "MINIMAX_AUDIO_FORMAT",
                                "MINIMAX_SAMPLE_RATE",
                                "MINIMAX_CHUNK_SECONDS",
                            ]:
                                env_lines.append(line)

            asr = self._config.asr
            env_lines.append(f"DASHSCOPE_API_KEY={asr.dashscope_api_key}")
            env_lines.append(f"PARAFORMER_WS_URL={asr.paraformer_ws_url}")
            env_lines.append(f"PARAFORMER_MODEL={asr.paraformer_model}")
            env_lines.append(f"PARAFORMER_SAMPLE_RATE={asr.paraformer_sample_rate}")
            env_lines.append(f"PARAFORMER_FORMAT={asr.paraformer_format}")
            env_lines.append(f"PARAFORMER_LANGUAGE_HINTS={asr.paraformer_language_hints}")
            env_lines.append(f"PARAFORMER_SEMANTIC_PUNCTUATION={'true' if asr.paraformer_semantic_punctuation else 'false'}")
            # MiniMax provider secrets/config — only persisted when populated
            # so empty keys from older installs don't leak into the .env file.
            if asr.minimax_api_key:
                env_lines.append(f"MINIMAX_API_KEY={asr.minimax_api_key}")
            env_lines.append(f"MINIMAX_ASR_MODEL={asr.minimax_asr_model}")
            env_lines.append(f"MINIMAX_BASE_URL={asr.minimax_base_url}")
            env_lines.append(f"MINIMAX_LANGUAGE={asr.minimax_language}")
            env_lines.append(f"MINIMAX_AUDIO_FORMAT={asr.minimax_audio_format}")
            env_lines.append(f"MINIMAX_SAMPLE_RATE={asr.minimax_sample_rate}")
            env_lines.append(f"MINIMAX_CHUNK_SECONDS={asr.minimax_chunk_seconds}")

            with open(ENV_FILE, "w", encoding="utf-8") as f:
                f.write("\n".join(env_lines) + "\n")
        except Exception as e:
            log.error("Failed to save .env file: %s", e)

    def get_config(self) -> AllConfig:
        return self._config

    def get_config_safe(self) -> dict:
        data = self._config.model_dump()
        if data["asr"]["dashscope_api_key"]:
            key = data["asr"]["dashscope_api_key"]
            data["asr"]["dashscope_api_key_masked"] = key[:8] + "****" + key[-4:] if len(key) > 12 else "****"
        else:
            data["asr"]["dashscope_api_key_masked"] = ""
        # Mirror the same masking for MiniMax — same secret-leak hygiene.
        if data["asr"].get("minimax_api_key"):
            key = data["asr"]["minimax_api_key"]
            data["asr"]["minimax_api_key_masked"] = key[:8] + "****" + key[-4:] if len(key) > 12 else "****"
        else:
            data["asr"]["minimax_api_key_masked"] = ""
        if data["llm"]["api_key"]:
            key = data["llm"]["api_key"]
            data["llm"]["api_key_masked"] = key[:8] + "****" + key[-4:] if len(key) > 12 else "****"
        else:
            data["llm"]["api_key_masked"] = ""
        return data

    def update_config(self, config: AllConfig) -> None:
        # Deep-merge: callers can send a partial config (e.g. only ASR fields)
        # without wiping the other sections. Empty-string secrets are treated
        # as "no change" so the frontend can safely round-trip without
        # accidentally clobbering stored credentials.
        self._config = self._merge_all(self._config, config)
        self._save_config()

    def update_asr_config(self, asr: ASRConfig) -> None:
        self._config.asr = self._merge_asr(self._config.asr, asr)
        self._save_config()

    def update_llm_config(self, llm: LLMConfig) -> None:
        self._config.llm = self._merge_llm(self._config.llm, llm)
        self._save_config()

    def update_analysis_config(self, analysis: AnalysisConfig) -> None:
        self._config.analysis = self._merge_analysis(self._config.analysis, analysis)
        self._save_config()

    @staticmethod
    def _merge_asr(old: ASRConfig, new: ASRConfig) -> ASRConfig:
        # Empty / None secrets fall back to old value — caller didn't intend
        # to overwrite the credential, they just didn't fill the field.
        def keep(field: str, default: str) -> str:
            v = getattr(new, field, None)
            return v if v else getattr(old, field, default)
        return ASRConfig(
            dashscope_api_key=keep("dashscope_api_key", ""),
            paraformer_ws_url=getattr(new, "paraformer_ws_url", None) or old.paraformer_ws_url,
            paraformer_model=getattr(new, "paraformer_model", None) or old.paraformer_model,
            paraformer_sample_rate=int(getattr(new, "paraformer_sample_rate", 0) or old.paraformer_sample_rate),
            paraformer_format=getattr(new, "paraformer_format", None) or old.paraformer_format,
            paraformer_language_hints=getattr(new, "paraformer_language_hints", None) or old.paraformer_language_hints,
            paraformer_semantic_punctuation=bool(
                getattr(new, "paraformer_semantic_punctuation", old.paraformer_semantic_punctuation)
            ),
            # MiniMax provider fields — independent of DashScope so a partial
            # update from the UI that only fills the DashScope key doesn't
            # accidentally clear the MiniMax side.
            minimax_api_key=keep("minimax_api_key", ""),
            minimax_asr_model=getattr(new, "minimax_asr_model", None) or old.minimax_asr_model,
            minimax_base_url=getattr(new, "minimax_base_url", None) or old.minimax_base_url,
            minimax_language=getattr(new, "minimax_language", old.minimax_language),
            minimax_audio_format=getattr(new, "minimax_audio_format", None) or old.minimax_audio_format,
            minimax_sample_rate=int(getattr(new, "minimax_sample_rate", 0) or old.minimax_sample_rate),
            minimax_chunk_seconds=float(getattr(new, "minimax_chunk_seconds", 0.0) or old.minimax_chunk_seconds),
        )

    @staticmethod
    def _merge_llm(old: LLMConfig, new: LLMConfig) -> LLMConfig:
        def keep(field: str, default: str) -> str:
            v = getattr(new, field, None)
            return v if v else getattr(old, field, default)
        return LLMConfig(
            api_key=keep("api_key", ""),
            base_url=getattr(new, "base_url", None) or old.base_url,
            model=getattr(new, "model", None) or old.model,
            temperature=float(getattr(new, "temperature", 0.0) or old.temperature),
            max_tokens=int(getattr(new, "max_tokens", 0) or old.max_tokens),
        )

    @staticmethod
    def _merge_analysis(old: AnalysisConfig, new: AnalysisConfig) -> AnalysisConfig:
        return AnalysisConfig(
            interval_seconds=int(getattr(new, "interval_seconds", 0) or old.interval_seconds),
            auto_start=bool(getattr(new, "auto_start", old.auto_start)),
            custom_prompt=getattr(new, "custom_prompt", None),
        )

    @classmethod
    def _merge_all(cls, old: AllConfig, new: AllConfig) -> AllConfig:
        return AllConfig(
            asr=cls._merge_asr(old.asr, new.asr),
            llm=cls._merge_llm(old.llm, new.llm),
            analysis=cls._merge_analysis(old.analysis, new.analysis),
        )

    def _load_analysis(self) -> AnalysisResult | None:
        if ANALYSIS_FILE.exists():
            try:
                data = json.loads(ANALYSIS_FILE.read_text(encoding="utf-8"))
                return AnalysisResult(**data)
            except Exception as e:
                log.warning("Failed to load analysis: %s", e)
        return None

    def _save_analysis(self) -> None:
        if self._analysis_result:
            try:
                ANALYSIS_FILE.write_text(
                    self._analysis_result.model_dump_json(indent=2),
                    encoding="utf-8",
                )
            except Exception as e:
                log.error("Failed to save analysis: %s", e)

    def get_analysis(self) -> AnalysisResult | None:
        return self._analysis_result

    def update_analysis(self, result: AnalysisResult) -> None:
        self._analysis_result = result
        self._save_analysis()

    def _load_status(self) -> AnalysisStatus:
        if STATUS_FILE.exists():
            try:
                data = json.loads(STATUS_FILE.read_text(encoding="utf-8"))
                return AnalysisStatus(**data)
            except Exception as e:
                log.warning("Failed to load status: %s", e)
        return AnalysisStatus()

    def _save_status(self) -> None:
        try:
            STATUS_FILE.write_text(
                self._status.model_dump_json(indent=2),
                encoding="utf-8",
            )
        except Exception as e:
            log.error("Failed to save status: %s", e)

    def get_status(self) -> AnalysisStatus:
        return self._status

    def update_status(self, **kwargs) -> None:
        for k, v in kwargs.items():
            if hasattr(self._status, k):
                setattr(self._status, k, v)
        self._save_status()

    def clear_analysis(self) -> None:
        self._analysis_result = None
        if ANALYSIS_FILE.exists():
            ANALYSIS_FILE.unlink()


storage = Storage()
