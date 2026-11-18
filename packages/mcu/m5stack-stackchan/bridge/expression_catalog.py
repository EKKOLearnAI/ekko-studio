"""Firmware resource semantics, not permission to randomly play every resource.

IDs/durations are pinned copies of the firmware whitelist and checked against
its source by tests. Restricted resources remain available to explicit/local
modes; they are deliberately absent from ordinary conversation scenes. All
strength/gain recommendations are normalized, never servo angles. Metadata
returns fresh JSON-safe containers and contains no paths or original chat.
"""
from dataclasses import asdict, dataclass
from math import ceil
from types import MappingProxyType
from typing import Optional

INTENTS = ("auto", "comfort", "celebrate", "curious", "reassure", "playful",
           "reflect", "agree", "disagree", "surprised", "apologize", "greet",
           "farewell", "rest", "focus", "encourage")


@dataclass(frozen=True)
class Scene:
    id: str
    intent: str
    emotion_id: str
    action_id: Optional[str]
    sound_id: Optional[str]
    max_strength: float
    sound_gain: float
    response_style: str
    duration_ms: int = 20000
    ttl_ms: int = 25000
    action_timing: str = "now"


_SCENES = (
    Scene("auto.warm", "auto", "19", "nod_slow", "home_final_nod", .30, .16, "warm"),
    Scene("auto.celebrate", "auto", "10", "hop", "home_joy", .55, .20, "warm"),
    Scene("auto.concerned", "auto", "16", "nod_slow", None, .35, 0., "concerned"),
    Scene("auto.calm", "auto", "35", None, None, 0., 0., "calm"),
    Scene("auto.neutral", "auto", "35", None, None, 0., 0., "neutral"),
    Scene("comfort", "comfort", "16", "nod_slow", None, .25, 0., "concerned", action_timing="speech_start"),
    Scene("celebrate", "celebrate", "19", "proud", "home_tada", .40, .22, "warm", action_timing="speech_start"),
    Scene("curious", "curious", "03", "hm", "home_hm", .28, .14, "curious"),
    Scene("reassure", "reassure", "16", "nod_slow", None, .25, 0., "concerned", action_timing="speech_start"),
    Scene("playful", "playful", "14", "giggle", "home_pop", .30, .14, "playful", action_timing="speech_start"),
    Scene("reflect", "reflect", "37", "recall", None, .22, 0., "reflective", action_timing="speech_start"),
    Scene("agree", "agree", "19", "nod", "home_nod", .30, .12, "warm", action_timing="speech_start"),
    Scene("disagree", "disagree", "11", "shake", None, .20, 0., "gentle_disagreement", action_timing="speech_start"),
    # Avoid the full-burst state 13 during ordinary chat: acknowledge surprise
    # with a small curious lift, rather than forcing a startle demonstration.
    Scene("surprised", "surprised", "03", "hey", "home_hm", .25, .14, "curious"),
    Scene("apologize", "apologize", "16", "nod_slow", None, .20, 0., "apologetic", action_timing="speech_start"),
    Scene("greet", "greet", "19", "hey", "home_hey", .30, .15, "warm", action_timing="speech_start"),
    Scene("farewell", "farewell", "19", "nod_slow", "home_final_nod", .25, .14, "warm", action_timing="speech_start"),
    Scene("rest", "rest", "02", None, None, 0., 0., "restful"),
    Scene("focus", "focus", "16", "focus", None, .25, 0., "focused", action_timing="speech_start"),
    Scene("encourage", "encourage", "16", "nod_slow", "home_final_nod", .28, .14, "encouraging", action_timing="speech_start"),
)
SCENES = MappingProxyType({scene.id: scene for scene in _SCENES})


def get_scene(identifier: str) -> Scene:
    if not isinstance(identifier, str) or identifier not in SCENES:
        raise ValueError("unknown expression scene")
    return SCENES[identifier]


@dataclass(frozen=True)
class Resource:
    id: str
    name: str
    purpose: str
    recommended_strength: float
    max_strength: float
    duration_ms: int
    automatic: bool
    compatible_intents: tuple[str, ...]
    restricted_modes: tuple[str, ...]
    disabled_when: tuple[str, ...]
    hold: bool = False
    sample_rate_hz: Optional[int] = None
    allowed_modes: tuple[str, ...] = ("explicit", "local")
    duration_kind: str = "lease"


_STATE_ROWS = (
    ("00", "睡眠"), ("01", "唤醒"), ("02", "待机放空"), ("03", "好奇"),
    ("04", "发呆"), ("05", "加载苏醒"), ("06", "休眠"), ("07", "抖动唤醒"),
    ("10", "开心"), ("11", "疑惑"), ("12", "失落"), ("13", "惊讶"),
    ("14", "害羞"), ("15", "疲惫"), ("16", "专注"), ("17", "慌张"),
    ("18", "无奈"), ("19", "满意"), ("20", "困惑"), ("21", "生气"),
    ("30", "思考中"), ("31", "接收任务"), ("32", "处理中忙碌"), ("33", "任务完成"),
    ("34", "出错"), ("35", "等待输入"), ("36", "联网加载"), ("37", "复述回忆"),
    ("38", "拒绝/受限"), ("39", "输出回复"), ("40", "检索资料"), ("41", "停止终止"),
)
_ACTION_ROWS = (
    ("nod", "轻点头", 580, False), ("nod3", "连续点头三次", 1400, False),
    ("nod_slow", "慢点头", 1300, False), ("shake", "温和否定摇头", 1000, False),
    ("hm", "好奇侧头", 2000, False), ("look_around", "左右张望", 2700, False),
    ("hey", "招呼抬头", 1000, False), ("hop", "开心弹动", 650, False),
    ("giggle", "小幅欢笑扭动", 750, False), ("dance", "表演舞动", 2800, False),
    ("dizzy", "表演眩晕", 1700, False), ("surprise", "突然抬头", 1300, False),
    ("jolt", "抖动惊醒", 420, False), ("droop", "低头保持", 1800, True),
    ("wake", "醒来动作", 1500, False), ("shy", "害羞偏头保持", 1200, True),
    ("proud", "轻轻挺头", 1900, False), ("sigh", "叹气低头", 1300, False),
    ("listen", "倾听姿态保持", 450, True), ("broadcast", "扫视房间", 1900, False),
    ("send", "发送示意", 700, False), ("think", "看右上思考", 500, True),
    ("recall", "看左上回忆", 500, True), ("search", "来回检索扫视", 1900, False),
    ("panic", "表演慌张", 1600, False), ("angry", "明显生气摆动", 2400, True),
    ("stop", "停止示意", 550, False), ("talk", "程序说话点动", 800, False),
    ("busy", "循环忙碌点动", 1000, True), ("stretch", "大幅伸展", 2300, False),
    ("pet", "抬头蹭手", 1300, True), ("track", "预设跟随表演", 3800, False),
    ("daze", "偏头发呆保持", 1200, True), ("sad", "失落低头保持", 1200, True),
    ("tired", "疲惫点头保持", 2700, True), ("focus", "专注姿态保持", 400, True),
    ("meh", "无奈姿态保持", 1600, True), ("boot", "启动张望", 2300, False),
    ("error", "出错示意", 650, False), ("look_up", "抬头保持", 250, True),
    ("flinch", "躲闪动作", 380, False),
    ("look_left", "向左看保持", 700, True),
    ("look_right", "向右看保持", 700, True),
    ("look_down", "低头保持", 500, True),
)
_CLIP_ROWS = (
    ("ekko_boot", "开机提示", 18672), ("ekko_eyes_open", "睁眼提示", 1629),
    ("ekko_happy", "短开心提示", 3669), ("ekko_ack", "收到确认", 7389),
    ("ekko_talk", "预录拟声表演，不是真实TTS", 18508),
    ("track_snore", "预录打鼾", 21058), ("track_face_found", "发现目标提示", 1271),
    ("track_eyes_open", "睁眼提示", 1629), ("track_surprise", "惊讶提示", 10680),
    ("track_heart", "爱心表演", 17951), ("track_its_you", "预录是你呀", 10229),
    ("track_dizzy", "眩晕表演", 25345), ("track_listen", "预录开始聆听", 21911),
    ("track_hm", "疑问提示", 5828), ("track_recognized", "预录识别成功", 24791),
    ("track_ok", "预录确认", 9188), ("track_lalala", "预录哼唱", 65348),
    ("track_giggle", "预录欢笑", 7983), ("home_sleep_z", "睡眠表演", 38708),
    ("home_wake", "醒来提示", 7748), ("home_detect", "发现提示", 3791),
    ("home_surprise", "惊讶提示", 3786), ("home_joy", "短喜悦提示", 7988),
    ("home_nod", "短点头确认", 4629), ("home_nod_x3", "三点头提示", 25429),
    ("home_giggle", "预录欢笑", 11629), ("home_hm", "温和疑问", 5349),
    ("home_send", "发送示意", 11687), ("home_wow", "预录赞叹", 10868),
    ("home_pop", "短弹出提示", 1271), ("home_hey", "短招呼", 4629),
    ("home_tada", "短庆祝", 14148), ("home_broadcast", "预录广播", 22631),
    ("home_lights_on", "灯光表演提示", 31510), ("home_final_nod", "温和认可", 9341),
    ("home_sigh", "短叹气", 3429),
    ("touch_dirty_hands", "连续抚摸后的俏皮边界语音：放开你的脏手", 28418),
)


def _resource(kind: str, identifier: str, name: str, duration: int, hold=False) -> Resource:
    field = {"states": "emotion_id", "actions": "action_id", "clips": "sound_id"}[kind]
    scenes = tuple(scene for scene in _SCENES if getattr(scene, field) == identifier)
    automatic = bool(scenes)
    compatible = tuple(intent for intent in INTENTS if any(s.intent == intent for s in scenes))
    recommended = max((s.sound_gain if kind == "clips" else s.max_strength for s in scenes), default=.25)
    purpose = name + ("；仅明确请求/本地模式，不自动猜测用户状态" if not automatic else "；按场景、置信与时序受控使用")
    disabled = ("boot_or_calibration", "expired_or_cancelled")
    if kind == "clips":
        disabled += ("recording", "speaker_busy", "no_safe_audio_gap", "external_audio_lease_unavailable")
    elif kind == "actions":
        disabled += ("recording", "servo_unavailable", "mechanical_limits")
    if not automatic:
        disabled += ("ordinary_chat_auto",)
    return Resource(identifier, name, purpose, recommended, 1., duration, automatic,
                    compatible, () if automatic else ("automatic",), disabled,
                    bool(hold), 24000 if kind == "clips" else None,
                    ("explicit", "local", "automatic") if automatic else ("explicit", "local"),
                    {"states": "lease", "actions": "keyframe_or_cycle", "clips": "audio"}[kind])


STATES = tuple(_resource("states", i, n, 20000) for i, n in _STATE_ROWS)
ACTIONS = tuple(_resource("actions", i, n, ms, hold) for i, n, ms, hold in _ACTION_ROWS)
CLIPS = tuple(_resource("clips", i, n, ceil(samples / 24)) for i, n, samples in _CLIP_ROWS)


def catalog_metadata() -> dict:
    """Fresh, JSON-safe metadata; changing a returned value cannot alter policy."""
    import json
    return json.loads(json.dumps({
        "version": "expression-director-v1", "personality": "gentle-curious",
        "intents": INTENTS, "states": [asdict(item) for item in STATES],
        "actions": [asdict(item) for item in ACTIONS], "clips": [asdict(item) for item in CLIPS],
        "scenes": [asdict(item) for item in _SCENES],
        "limits": {"automatic_strength": .55, "automatic_sound_gain": .35,
                   "duration_ms": 30000, "ttl_ms": 30000},
        "interpretation": "robot_expression_plan_not_user_psychology",
    }, ensure_ascii=False, allow_nan=False))
