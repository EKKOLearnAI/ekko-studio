from __future__ import annotations

from pydantic import BaseModel, Field


class ASRConfig(BaseModel):
    dashscope_api_key: str = ""
    paraformer_ws_url: str = "wss://dashscope.aliyuncs.com/api-ws/v1/inference"
    paraformer_model: str = "paraformer-realtime-v2"
    paraformer_sample_rate: int = 16000
    paraformer_format: str = "pcm"
    paraformer_language_hints: str = "zh,en"
    paraformer_semantic_punctuation: bool = True
    # ------------------------------------------------------------------
    # MiniMax provider (https://platform.minimax.cn/docs/api-reference/speech-to-text)
    # ------------------------------------------------------------------
    # The MiniMax ASR API is REST-only and rejects raw PCM (it needs a
    # container — wav / mp3 / opus / aac / ogg). The Python layer encodes
    # 16 kHz mono PCM chunks into a container before each request and posts
    # them with a Bearer-token Authorization header. See `asr_minimax.py`.
    minimax_api_key: str = ""
    minimax_asr_model: str = "asr-1.0"
    minimax_base_url: str = "https://api.minimaxi.com"
    minimax_language: str = ""  # empty → API's mixed-language auto mode
    minimax_audio_format: str = "wav"
    minimax_sample_rate: int = 16000
    # 500s is the API hard cap (per request). Smaller values trade latency
    # for more requests; the Python client splits the recording stream into
    # rolling windows of this size.
    minimax_chunk_seconds: float = 12.0


class LLMConfig(BaseModel):
    api_key: str = ""
    base_url: str = "https://api.deepseek.com"
    model: str = "deepseek-chat"
    temperature: float = 0.7
    max_tokens: int = 4096


class AnalysisConfig(BaseModel):
    interval_seconds: int = Field(default=60, ge=10, le=600)
    interval_sentences: int = Field(default=10, ge=1, le=100)
    trigger_mode: str = Field(default="sentences")  # "sentences" | "time" | "both"
    auto_start: bool = False
    custom_prompt: str | None = None


class AllConfig(BaseModel):
    asr: ASRConfig = Field(default_factory=ASRConfig)
    llm: LLMConfig = Field(default_factory=LLMConfig)
    analysis: AnalysisConfig = Field(default_factory=AnalysisConfig)


class AnalysisResult(BaseModel):
    meeting_type: str = "其他"
    summary: str = ""
    key_points: list[str] = Field(default_factory=list)
    action_items: list[dict] = Field(default_factory=list)
    people_mentioned: list[str] = Field(default_factory=list)
    relationships: list[dict] = Field(default_factory=list)
    topics: list[str] = Field(default_factory=list)
    feedback: dict = Field(default_factory=dict)
    decisions: list[str] = Field(default_factory=list)
    risks: list[str] = Field(default_factory=list)
    learnings: list[str] = Field(default_factory=list)
    should_update_html: bool = False
    html_content: str | None = None
    timestamp: float = 0.0


class AnalysisStatus(BaseModel):
    is_running: bool = False
    last_update: float = 0.0
    total_analyses: int = 0
    current_interval: int = 60
    error: str | None = None


class AnalysisRequest(BaseModel):
    interval_seconds: int = Field(default=60, ge=10, le=600)
    interval_sentences: int = Field(default=10, ge=1, le=100)
    trigger_mode: str = Field(default="sentences")
    custom_prompt: str | None = None


class PromptTemplate(BaseModel):
    name: str
    description: str
    template: str


DEFAULT_PROMPTS = {
    "meeting_analysis": PromptTemplate(
        name="会议分析",
        description="分析会议内容，提取关键信息",
        template="""请分析以下会议转写内容，首先判断会议类型，然后根据类型生成相应的分析结果。

会议类型判断指南：
- **会议纪要**：包含议题、讨论、决议、待办事项和负责人
- **客户回访**：包含客户反馈、满意度、问题、建议
- **头脑风暴**：包含创意、想法、可行性分析
- **项目汇报**：包含进度、风险、下一步计划
- **培训分享**：包含知识点、要点、学习建议
- **其他**：根据实际内容判断

请以 JSON 格式返回：
{
  "meeting_type": "会议类型",
  "summary": "会议摘要（150字以内）",
  "key_points": ["关键要点1", "关键要点2", ...],
  "action_items": [
    {"task": "待办事项", "assignee": "负责人", "deadline": "截止时间（如有）"}
  ],
  "people_mentioned": ["人名1", "人名2", ...],
  "relationships": [{"source": "人名A", "target": "人名B", "relation": "关系描述"}, ...],
  "topics": ["主题1", "主题2", ...],
  "feedback": {
    "positive": ["积极反馈1", ...],
    "negative": ["消极反馈1", ...]
  },
  "decisions": ["决议1", ...],
  "risks": ["风险1", ...],
  "learnings": ["知识点1", ...]
}

注意：
- 根据会议类型，某些字段可以为空数组
- 会议纪要类型：重点提取action_items和decisions
- 客户回访类型：重点提取feedback
- 头脑风暴类型：重点提取key_points和risks
- 项目汇报类型：重点提取risks和action_items
- 培训分享类型：重点提取learnings

会议内容：
{transcript}""",
    ),
    "html_generation": PromptTemplate(
        name="HTML生成",
        description="基于分析结果生成可视化HTML",
        template="""基于以下会议分析结果，生成一个完整的、可直接在浏览器中打开的 HTML 页面。

重要要求：
1. **完全自由设计**：不要使用固定模板，根据会议类型和内容自由设计页面结构
2. **内容驱动**：页面布局、组件、样式都应反映会议的实际内容
3. **智能组件选择**：
   - 如果有action_items，生成待办事项清单（带负责人和截止时间）
   - 如果有feedback，生成客户反馈分析（积极/消极对比）
   - 如果有decisions，生成决议列表
   - 如果有risks，生成风险评估卡片
   - 如果有learnings，生成知识点总结
   - 如果有relationships，生成人物关系图（使用ECharts）
4. **视觉设计**：
   - 使用现代简洁的UI风格
   - 响应式布局
   - 合理的配色和排版
   - 中文字体优化
5. **技术要求**：
   - 使用 ECharts CDN (https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js)（如需要）
   - 所有CSS内联
   - 所有JavaScript内联
   - 页面标题：{meeting_type} - 分析报告
6. **不要包含**：
   - 任何模板化的结构
   - 固定的卡片布局
   - 不相关的占位内容

只返回完整的 HTML 代码，不要有任何额外说明。

分析结果：
{analysis_json}""",
    ),
}
