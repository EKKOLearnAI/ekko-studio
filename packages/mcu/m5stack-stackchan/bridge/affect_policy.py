"""Bounded, in-memory expression planning; no transport or chat text is accepted.

``now`` is monotonic seconds; durations/TTLs are milliseconds. Call commit only
after the device accepts the exact decision. Planning (including no-send plans)
never changes state, so the neutral hold is measured from the last *accepted*
automatic expression, not from every conversation sentence. The EWMA smooths
gesture strength; semantic classification remains the caller/LLM's job.

Call reset on MCP restart/device boot changes. After an accepted explicit
set_emotion, mark_explicit protects that command's original duration. Explicit
commands themselves bypass this policy. Callers must serialize plan/dispatch/
commit and recheck device boot/turn ownership before dispatch.
"""

from dataclasses import dataclass, InitVar
import math
from numbers import Real
from typing import Optional, Tuple
from expression_catalog import INTENTS, get_scene


_MOODS = {"neutral", "happy", "sad", "angry", "anxious", "tired"}
_STYLES = {
    "neutral": "neutral", "happy": "warm", "sad": "concerned",
    "angry": "calm", "anxious": "concerned", "tired": "concerned",
}
_SEMANTIC_IDS = set(range(8)) | set(range(10, 22)) | set(range(30, 42))
_MIN_CONFIDENCE = .65
_CHANGE_CONFIDENCE = .75
_MIN_HOLD = 8.0
_NEUTRAL_HOLD = 30.0
_FORGET_AFTER = 60.0
_ALPHA = .35
_DURATION_MS = 20_000
_TTL_MS = 25_000
_BASE_ACTOR = (0.0, .18, .45)
_ACTOR_TARGETS = {
    "neutral": _BASE_ACTOR, "warm": (.65, .50, .80),
    "concerned": (.15, .18, .85), "calm": (.05, .10, .85),
    "curious": (.25, .35, .85), "playful": (.55, .50, .80),
    "reflective": (.08, .20, .65), "gentle_disagreement": (.05, .18, .75),
    "apologetic": (-.10, .18, .75), "restful": (.05, .08, .30),
    "focused": (.10, .28, .90), "encouraging": (.30, .28, .85),
}


@dataclass(frozen=True)
class _Proposal:
    owner: object
    revision: int
    planned_at: float
    style: str
    payload: Tuple[object, ...]
    actor: Tuple[float, float, float]
    intent: str


@dataclass(frozen=True)
class Decision:
    send: bool
    emotion_id: Optional[str]
    action_id: Optional[str]
    strength: float
    duration_ms: int
    ttl_ms: int
    response_style: str
    reason: str
    sound_id: Optional[str] = None
    sound_gain: float = 0.0
    action_timing: str = "now"
    scene_id: Optional[str] = None
    # InitVar keeps process-local validation metadata out of asdict/JSON.
    _proposal: InitVar[Optional[_Proposal]] = None

    def __post_init__(self, _proposal: Optional[_Proposal]) -> None:
        object.__setattr__(self, "_proposal_data", _proposal)


def _number(value: Real, name: str, maximum: Optional[float] = None) -> float:
    if isinstance(value, bool) or not isinstance(value, Real):
        raise ValueError(f"{name} must be a finite number")
    try:
        result = float(value)
    except (OverflowError, ValueError):
        raise ValueError(f"{name} must be a finite number") from None
    if not math.isfinite(result) or result < 0 or (maximum is not None and result > maximum):
        raise ValueError(f"{name} is outside its finite range")
    return result


def _visible(value: object) -> Optional[str]:
    if value is None or (type(value) is int and value == -1):
        return None
    if type(value) is int and value in _SEMANTIC_IDS:
        return f"{value:02d}"
    if isinstance(value, str) and len(value) == 2 and value.isascii() and value.isdigit():
        if int(value) in _SEMANTIC_IDS:
            return value
    raise ValueError("visible_emotion must be a semantic ID or None")


def _payload(decision: Decision) -> Tuple[object, ...]:
    return (decision.send, decision.emotion_id, decision.action_id, decision.strength,
            decision.duration_ms, decision.ttl_ms, decision.response_style, decision.reason,
            decision.sound_id, decision.sound_gain, decision.action_timing, decision.scene_id)


def _decay_actor(actor: Tuple[float, float, float], age: float) -> Tuple[float, float, float]:
    if age > _FORGET_AFTER:
        return _BASE_ACTOR
    weight = math.exp(-max(0., age) / 30.)
    return tuple(base + (value - base) * weight for base, value in zip(_BASE_ACTOR, actor))


class AffectPolicy:
    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        """Forget all affect/protection and invalidate previously planned work."""
        self._owner = object()
        self._revision = 0
        self._style: Optional[str] = None
        self._strength = 0.0
        self._committed_at: Optional[float] = None
        self._clock_floor: Optional[float] = None
        self._explicit_until = 0.0
        self._actor = _BASE_ACTOR
        self._actor_at: Optional[float] = None
        self._last_scene: Optional[str] = None
        self._last_intent: Optional[str] = None

    def _now(self, now: Real) -> float:
        result = _number(now, "now")
        if self._clock_floor is not None and result < self._clock_floor:
            raise ValueError("monotonic time moved backwards; reset policy")
        return result

    def mark_explicit(self, now: Real, duration_ms: int) -> None:
        """Protect an accepted explicit command, replacing any older protection."""
        at = self._now(now)
        if type(duration_ms) is not int or not 1 <= duration_ms <= 30_000:
            raise ValueError("duration_ms must be an integer in 1..30000")
        self._explicit_until = at + duration_ms / 1000.0
        self._clock_floor = at
        # An explicit expression is not evidence of the user's automatic mood.
        self._style = None
        self._strength = 0.0
        self._committed_at = None
        self._revision += 1

    def snapshot(self, now: Real) -> dict:
        """Pure, decaying robot expression state; never a user diagnosis.

        Last-scene fields describe the last accepted automatic plan, not an
        assertion that the corresponding expression is still visible.
        """
        at = self._now(now)
        actor = (_BASE_ACTOR if self._actor_at is None else
                 _decay_actor(self._actor, at - self._actor_at))
        return dict(zip(("valence", "arousal", "engagement"), actor),
                    personality="gentle-curious", last_scene=self._last_scene,
                    last_intent=self._last_intent, committed_at=self._actor_at)

    def plan(self, user_emotion: str, confidence: Real, intensity: Real, *,
             now: Real, visible_emotion: object, intent: str = "auto") -> Decision:
        if not isinstance(user_emotion, str) or user_emotion not in _MOODS:
            raise ValueError("user_emotion must be one of the six supported moods")
        if not isinstance(intent, str) or intent not in INTENTS:
            raise ValueError("intent must be one of the supported scene intents")
        confidence = _number(confidence, "confidence", 1.0)
        intensity = _number(intensity, "intensity", 1.0)
        at = self._now(now)
        visible = _visible(visible_emotion)
        response = _STYLES[user_emotion]

        def skip(reason: str) -> Decision:
            return Decision(False, None, None, 0.0, _DURATION_MS, _TTL_MS, response, reason)

        if at < self._explicit_until:
            return skip("explicit_hold")
        if confidence < _MIN_CONFIDENCE:
            return skip("low_confidence")
        if visible is None:
            return skip("unknown_visible")

        age = None if self._committed_at is None else at - self._committed_at
        stale = age is not None and age > _FORGET_AFTER
        current = None if stale else self._style
        automatic = intent == "auto"
        overridden = False
        if not automatic:
            scene = get_scene(intent)
            if user_emotion == "angry":
                scene, overridden = get_scene("auto.calm"), True
            elif user_emotion in {"sad", "anxious", "tired"} and (
                    scene.emotion_id in {"10", "14", "19"} or
                    intent in {"celebrate", "playful", "surprised", "disagree"}):
                scene, overridden = get_scene("comfort"), True
            response = scene.response_style
        elif user_emotion == "neutral":
            # Do not replace unrelated/manual expressions or initialize a face
            # simply because an ordinary sentence was classified as neutral.
            if self._style in {None, "neutral"}:
                return skip("neutral_no_change")
            if age is not None and age < _NEUTRAL_HOLD:
                return skip("neutral_hold")
            if current is not None and confidence < _CHANGE_CONFIDENCE:
                return skip("style_confidence")
            scene = get_scene("auto.neutral")
        else:
            if response == "warm":
                # Both warm faces belong to one style. A change in estimated
                # intensity alone must not alternate smiling/jumping faces.
                if current == "warm" and visible in {"19", "10"}:
                    return skip("same_style_visible")
                excited = intensity >= .8 and confidence >= .85
                scene = get_scene("auto.celebrate" if excited else "auto.warm")
            elif response == "concerned":
                scene = get_scene("auto.concerned")
            else:
                scene = get_scene("auto.calm")

        emotion, action, cap = scene.emotion_id, scene.action_id, scene.max_strength
        urgent = (current in {"warm", "playful"} and response in {"concerned", "calm"}
                  and confidence >= _CHANGE_CONFIDENCE)
        if user_emotion != "neutral" or not automatic:
            if automatic and current == response and visible == emotion:
                return skip("same_style_visible")
            if not automatic and current is not None and self._last_scene == scene.id and visible == emotion:
                return skip("same_scene_visible")
            changing = response != current or (not automatic and self._last_scene != scene.id)
            if current is not None and changing and confidence < _CHANGE_CONFIDENCE:
                return skip("style_confidence")
            if current is not None and age is not None and age < _MIN_HOLD and not urgent:
                return skip("minimum_hold")

        if visible == emotion and (automatic or (action is None and scene.sound_id is None)):
            return skip("already_visible")
        base = (_BASE_ACTOR if self._actor_at is None else
                _decay_actor(self._actor, at - self._actor_at))
        # Accepted interaction history gently modulates delivery, rather than
        # exposing a decorative state vector that never affects expression.
        # Arousal/engagement can only soften the scene's existing safe caps.
        energy = .6 * base[1] + .4 * base[2]
        target = cap * intensity
        if not automatic:
            target *= .75 + .25 * energy
        # A hard zero stays motionless. Discard stale strength after a pause;
        # otherwise smooth towards the next bounded gesture's target strength.
        if target == 0 or current is None:
            strength = target
        else:
            strength = self._strength + _ALPHA * (target - self._strength)
        strength = max(0.0, min(cap, strength))
        if strength == 0:
            action = None
        reason = ("negative_intent_override" if overridden else "neutral_settle" if response == "neutral" else
                  "negative_priority" if urgent else "stale_context" if stale else "expression")
        quiet = user_emotion in {"sad", "angry", "anxious", "tired"} or intensity == 0
        sound = None if quiet else scene.sound_id
        gain = min(.35, scene.sound_gain * (.5 + .5 * intensity) * (.8 + .2 * energy)) if sound else 0.
        timing = scene.action_timing if action else "now"
        result = Decision(True, emotion, action, strength, scene.duration_ms, scene.ttl_ms,
                          response, reason, sound, gain, timing, scene.id)
        target = _ACTOR_TARGETS[response]
        influence = confidence * (.25 + .75 * intensity)
        actor = tuple(old + _ALPHA * influence * (new - old) for old, new in zip(base, target))
        proposal = _Proposal(self._owner, self._revision, at, response, _payload(result), actor, scene.intent)
        return Decision(*_payload(result), _proposal=proposal)

    def commit(self, decision: Decision, now: Real) -> bool:
        """Record an accepted, unchanged, unexpired plan once; never sends I/O.

        False means the plan was a no-op, stale, modified, from another policy,
        or exceeded its planning TTL. A failed transport must not call commit.
        """
        at = self._now(now)
        if not isinstance(decision, Decision) or not decision.send:
            return False
        proposal = getattr(decision, "_proposal_data", None)
        if (proposal is None or proposal.owner is not self._owner or
                proposal.revision != self._revision or proposal.payload != _payload(decision) or
                any(type(expected) is not type(actual)
                    for expected, actual in zip(proposal.payload, _payload(decision))) or
                at < proposal.planned_at or at - proposal.planned_at >= decision.ttl_ms / 1000.0 or
                at < self._explicit_until):
            return False
        self._style = proposal.style
        self._strength = decision.strength
        self._committed_at = self._clock_floor = at
        self._actor = _decay_actor(proposal.actor, at - proposal.planned_at)
        self._actor_at = at
        self._last_scene = decision.scene_id
        self._last_intent = proposal.intent
        self._revision += 1
        return True
