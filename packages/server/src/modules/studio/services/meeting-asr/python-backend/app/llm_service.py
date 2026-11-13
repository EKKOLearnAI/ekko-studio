from __future__ import annotations

import asyncio
import json
import logging
import time

from openai import AsyncOpenAI

from .models import AnalysisResult, DEFAULT_PROMPTS, LLMConfig
from .storage import storage

log = logging.getLogger("llm_service")


class LLMService:
    def __init__(self) -> None:
        self._client: AsyncOpenAI | None = None
        self._last_config: LLMConfig | None = None
        self._transcript_buffer: list[str] = []
        self._last_analysis_text: str = ""
        self._analysis_count: int = 0
        self._sentence_buffer: list[str] = []
        self._last_analyzed_sentence_count: int = 0

    def _get_client(self, config: LLMConfig) -> AsyncOpenAI:
        if self._client is None or self._last_config != config:
            self._client = AsyncOpenAI(
                api_key=config.api_key,
                base_url=config.base_url,
            )
            self._last_config = config
        return self._client

    def add_transcript(self, text: str) -> None:
        if text and text.strip():
            self._transcript_buffer.append(text.strip())

    def get_transcript(self) -> str:
        return "\n".join(self._transcript_buffer)

    def clear_transcript(self) -> None:
        self._transcript_buffer.clear()
        self._sentence_buffer.clear()
        self._last_analysis_text = ""
        self._analysis_count = 0
        self._last_analyzed_sentence_count = 0

    def add_sentence(self, sentence: str) -> None:
        """添加句子到缓冲区"""
        if sentence and sentence.strip():
            self._sentence_buffer.append(sentence.strip())

    def get_sentence_count(self) -> int:
        """获取当前句子数量"""
        return len(self._sentence_buffer)

    def _should_analyze_by_sentences(self, min_sentences: int = 10) -> bool:
        """基于句子数量判断是否需要分析"""
        current_count = len(self._sentence_buffer)
        if current_count < min_sentences:
            return False
        if current_count - self._last_analyzed_sentence_count < min_sentences:
            return False
        return True

    def _mark_analyzed(self) -> None:
        """标记当前句子已分析"""
        self._last_analyzed_sentence_count = len(self._sentence_buffer)

    def _should_analyze(self, min_length: int = 50) -> bool:
        """Deprecated: kept for backward compat with trigger endpoint."""
        current = self.get_transcript()
        if len(current) < min_length:
            return False
        if current == self._last_analysis_text:
            return False
        return True

    async def analyze(self, custom_prompt: str | None = None) -> AnalysisResult:
        config = storage.get_config().llm
        if not config.api_key:
            raise ValueError("API Key 未配置")

        transcript = self.get_transcript()
        if not transcript:
            raise ValueError("没有转写内容可供分析")

        client = self._get_client(config)

        prompt_template = custom_prompt or DEFAULT_PROMPTS["meeting_analysis"].template
        prompt = prompt_template.replace("{transcript}", transcript)

        try:
            response = await client.chat.completions.create(
                model=config.model,
                messages=[
                    {"role": "system", "content": "你是一个专业的会议分析助手，擅长提取会议关键信息并以结构化 JSON 格式返回。"},
                    {"role": "user", "content": prompt},
                ],
                temperature=config.temperature,
                max_tokens=config.max_tokens,
                response_format={"type": "json_object"},
            )

            content = response.choices[0].message.content
            if not content:
                raise ValueError("模型返回空内容")

            data = json.loads(content)

            self._last_analysis_text = transcript
            self._analysis_count += 1

            result = AnalysisResult(
                meeting_type=data.get("meeting_type", "其他"),
                summary=data.get("summary", ""),
                key_points=data.get("key_points", []),
                action_items=data.get("action_items", []),
                people_mentioned=data.get("people_mentioned", []),
                relationships=data.get("relationships", []),
                topics=data.get("topics", []),
                feedback=data.get("feedback", {}),
                decisions=data.get("decisions", []),
                risks=data.get("risks", []),
                learnings=data.get("learnings", []),
                should_update_html=self._should_update_html(data),
                timestamp=time.time(),
            )

            return result

        except json.JSONDecodeError as e:
            log.error("Failed to parse LLM response as JSON: %s", e)
            raise ValueError(f"模型返回格式错误: {e}")
        except Exception as e:
            log.error("LLM analysis failed: %s", e)
            raise

    def _should_update_html(self, data: dict) -> bool:
        if self._analysis_count <= 2:
            return True

        prev = storage.get_analysis()
        if not prev:
            return True

        new_people = set(data.get("people_mentioned", []))
        old_people = set(prev.people_mentioned)
        if new_people - old_people:
            return True

        new_actions = set(data.get("action_items", []))
        old_actions = set(prev.action_items)
        if new_actions - old_actions:
            return True

        new_points = len(data.get("key_points", []))
        old_points = len(prev.key_points)
        if new_points > old_points + 2:
            return True

        if self._analysis_count % 3 == 0:
            return True

        return False

    async def generate_html(self, analysis: AnalysisResult) -> str:
        config = storage.get_config().llm
        if not config.api_key:
            raise ValueError("API Key 未配置")

        client = self._get_client(config)

        analysis_json = analysis.model_dump_json(indent=2)
        prompt = DEFAULT_PROMPTS["html_generation"].template.replace(
            "{analysis_json}", analysis_json
        )

        try:
            response = await client.chat.completions.create(
                model=config.model,
                messages=[
                    {"role": "system", "content": "你是一个专业的前端开发助手，擅长使用 ECharts 创建数据可视化页面。只返回完整的 HTML 代码。"},
                    {"role": "user", "content": prompt},
                ],
                temperature=0.3,
                max_tokens=8192,
            )

            html = response.choices[0].message.content
            if not html:
                raise ValueError("模型返回空 HTML")

            html = html.strip()
            if html.startswith("```html"):
                html = html[7:]
            if html.startswith("```"):
                html = html[3:]
            if html.endswith("```"):
                html = html[:-3]
            html = html.strip()

            return html

        except Exception as e:
            log.error("HTML generation failed: %s", e)
            raise

    async def run_analysis_cycle(self, custom_prompt: str | None = None) -> AnalysisResult | None:
        """Deprecated: timed analysis removed in v0.7.16. Kept as no-op for API compat."""
        log.info("run_analysis_cycle called but timed analysis is deprecated; use Node realtime-assist instead")
        return None


llm_service = LLMService()
