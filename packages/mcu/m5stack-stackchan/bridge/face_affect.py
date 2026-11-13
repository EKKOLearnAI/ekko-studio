"""Local, abstaining visible-expression estimates, never psychological facts.

Official model/preprocessing/labels:
https://github.com/onnx/models/tree/main/validated/vision/body_analysis/emotion_ferplus
Input is float32 NCHW (1,1,64,64), grayscale values 0..255, without /255 or
standardization. Output logits need softmax; probabilities are not calibrated
accuracy. FER+ labels are crowd judgments of photographs, not measured feelings:
https://github.com/microsoft/FERPlus

The explicit ``mobilefacenet`` backend uses OpenCV Zoo's Progressive Teacher
MobileFaceNet model and its non-reflective five-point similarity alignment:
https://github.com/opencv/opencv_zoo/tree/48b10fa505aeb51fbd127fc60a5c660040e823b7/models/facial_expression_recognition
Its input is RGB float32 NCHW (1,3,112,112), normalized to [-1,1]. Seven
logits map to the same public eight-label order, with contempt probability zero.

Training demographics, lighting, pose, occlusion and this camera's small crop
are not calibrated here. Multiple consistent frames reduce flicker, not bias.
No age, identity, health, personality, or true mental state is inferred.

Only the existing device's locked-target sample is accepted: gray8 for FER+,
or bounded 112x112 color JPEG plus five landmarks for MobileFaceNet. This module
opens no camera, serial port or network connection and writes no files. Pixels
exist only in infer's local variables; retained state is bounded numeric
summaries and opaque target/frame identifiers. Callers must also avoid logging
the input sample. ``now`` uses local monotonic seconds, not the device clock.
"""

from __future__ import annotations

import base64
import binascii
from dataclasses import asdict, dataclass, replace
import hashlib
import math
from numbers import Real
from pathlib import Path
import threading
from typing import Any

try:
    import numpy as np
except ImportError:  # Optional feature must not prevent the main MCP starting.
    np = None


LABELS = ("neutral", "happiness", "surprise", "sadness", "anger", "disgust",
          "fear", "contempt")
_MOODS = {"neutral": "neutral", "happiness": "happy", "sadness": "sad",
          "anger": "angry", "fear": "anxious"}
MODEL_SHA256 = "a2a2ba6a335a3b29c21acb6272f962bd3d47f84952aaffa03b60986e04efa61c"
MODEL_SIZE = 35_040_571
MOBILEFACENET_SHA256 = "4f61307602fc089ce20488a31d4e4614e3c9753a7d6c41578c854858b183e1a9"
MOBILEFACENET_SIZE = 4_791_892
_MOBILE_TO_CANONICAL = (4, 5, 6, 1, 0, 3, 2)
_ALIGN_POINTS = ((38.2946, 51.6963), (73.5318, 51.5014), (56.0252, 71.7366),
                 (41.5493, 92.3655), (70.7299, 92.2041))
_MAX_JPEG_BYTES = 4096
_PIXELS = 64 * 64
_ENCODED_SIZE = ((_PIXELS + 2) // 3) * 4
_MAX_AGE = 3.0
_MIN_CONFIDENCE = .70
_MIN_MARGIN = .45
_MIN_FRAMES = 3
_EMA_ALPHA = .40
# Exact firmware sampling reason codes, never free-form device text. Values are
# local constants so a rejected response cannot inject instructions or pixels
# into status diagnostics. Keep the validity/lock gates themselves unchanged.
_DEVICE_REJECTION_REASONS = {reason: reason for reason in (
    "occlusion_suspected", "stale", "timeout", "invalid_box", "low_confidence",
    "face_too_small", "clipped", "invalid_pixels", "ambiguous", "no_face",
    "unlocked", "target_lost", "target_changed", "target_mismatch", "disabled",
    "allocation_failed", "unavailable",
)}


@dataclass(frozen=True)
class FaceEstimate:
    status: str = "unavailable"
    stable: bool = False
    mood: str = "unknown"
    expression: str = "unknown"
    confidence: float = 0.0
    track_id: int | None = None
    frame_id: int | None = None
    frames: int = 0
    observed_at: float | None = None
    expires_at: float | None = None
    reason: str = "not_initialized"
    margin: float = 0.0
    probabilities: tuple[float, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        result = asdict(self)
        result["probabilities"] = dict(zip(LABELS, self.probabilities))
        result["interpretation"] = "visible_expression_only"
        return result


def _uint32(value: object, *, positive: bool = False) -> bool:
    return type(value) is int and int(positive) <= value <= 0xFFFFFFFF


def _newer(value: int, previous: int) -> bool:
    delta = (value - previous) & 0xFFFFFFFF
    return 0 < delta < 0x80000000


def _finite(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, Real):
        return None
    try:
        number = float(value)
    except (ValueError, OverflowError):
        return None
    return number if math.isfinite(number) and number >= 0 else None


def _device_rejection(sample: dict, fallback: str) -> str:
    value = sample.get("reason")
    return _DEVICE_REJECTION_REASONS.get(value, fallback) if type(value) is str else fallback


def _bounded_color_jpeg(data: bytes) -> bool:
    """Read marker lengths before a native decoder can allocate image storage.

    Accept one 112x112, 8-bit three-component baseline/progressive image. Scan
    all headers (including later progressive scans), so an earlier small SOF
    cannot hide a second larger frame. No decoded pixels or marker text escape.
    """
    if not 4 <= len(data) <= _MAX_JPEG_BYTES or data[:2] != b"\xff\xd8":
        return False
    at, components, in_scan, saw_scan = 2, None, False, False
    while at < len(data):
        if in_scan:
            marker_at = data.find(b"\xff", at)
            if marker_at < 0:
                return False
            at = marker_at
        if data[at] != 0xFF:
            return False
        while at < len(data) and data[at] == 0xFF:
            at += 1
        if at >= len(data):
            return False
        marker = data[at]
        at += 1
        if in_scan and (marker == 0 or 0xD0 <= marker <= 0xD7):
            continue
        in_scan = False
        if marker == 0xD9:
            return components is not None and saw_scan and at == len(data)
        if marker in (0, 1, 0xD8, 0xDC) or 0xD0 <= marker <= 0xD7:
            return False
        if at + 2 > len(data):
            return False
        length = int.from_bytes(data[at:at + 2], "big")
        if length < 2 or at + length > len(data):
            return False
        payload = data[at + 2:at + length]
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            if (marker not in (0xC0, 0xC2) or components is not None
                    or len(payload) != 15 or payload[0] != 8
                    or int.from_bytes(payload[1:3], "big") != 112
                    or int.from_bytes(payload[3:5], "big") != 112
                    or payload[5] != 3):
                return False
            components = tuple(payload[i] for i in (6, 9, 12))
            if len(set(components)) != 3:
                return False
            for i in (7, 10, 13):
                if not (1 <= payload[i] >> 4 <= 4 and 1 <= (payload[i] & 15) <= 4
                        and payload[i + 1] <= 3):
                    return False
        elif marker == 0xDA:
            if (components is None or len(payload) < 4
                    or not 1 <= payload[0] <= 3 or len(payload) != 4 + 2 * payload[0]):
                return False
            selectors = tuple(payload[i] for i in range(1, 1 + 2 * payload[0], 2))
            if len(set(selectors)) != len(selectors) or any(i not in components for i in selectors):
                return False
            in_scan = saw_scan = True
        at += length
    return False


def _landmarks(value: object) -> Any:
    # Wire order is image-left eye, image-right eye, nose, image-left mouth,
    # image-right mouth, flat x,y pairs in the unmirrored 112-pixel ROI.
    if type(value) is not list or len(value) != 10:
        return None
    numbers = [_finite(number) for number in value]
    if any(number is None or number >= 112 for number in numbers):
        return None
    points = np.asarray(numbers, dtype=np.float64).reshape(5, 2)
    eye = points[1] - points[0]
    mouth = points[4] - points[3]
    eye_distance, mouth_distance = np.linalg.norm(eye), np.linalg.norm(mouth)
    if (eye[0] < 4 or mouth[0] < 2 or not 8 <= eye_distance <= 100
            or not 4 <= mouth_distance <= 90):
        return None
    across = eye / eye_distance
    down = np.array([-across[1], across[0]])
    eye_mid, mouth_mid = (points[0] + points[1]) / 2, (points[3] + points[4]) / 2
    depth = float((mouth_mid - eye_mid) @ down)
    nose_depth = float((points[2] - eye_mid) @ down)
    if (not 6 <= depth <= 90 or not 0 < nose_depth < depth
            or abs(float((points[2] - eye_mid) @ across)) > eye_distance
            or abs(float((mouth_mid - eye_mid) @ across)) > eye_distance
            or float(mouth @ across) <= 0):
        return None
    return points


def _alignment_matrix(points: Any) -> Any:
    # OpenCV Zoo FaceAlignment's default non-reflective least-squares fit:
    # fit canonical -> observed, invert, then use OpenCV's 2x3 convention.
    target = np.asarray(_ALIGN_POINTS, dtype=np.float64)
    x, y = target[:, 0:1], target[:, 1:2]
    ones, zeros = np.ones((5, 1)), np.zeros((5, 1))
    design = np.vstack((np.hstack((x, y, ones, zeros)),
                        np.hstack((y, -x, zeros, ones))))
    observed = np.concatenate((points[:, 0], points[:, 1]))
    scale, rotation, tx, ty = np.linalg.lstsq(design, observed, rcond=-1)[0]
    inverse = np.array([[scale, -rotation, 0.], [rotation, scale, 0.], [tx, ty, 1.]])
    transform = np.linalg.inv(inverse)
    transform[:, 2] = (0., 0., 1.)
    return transform[:, :2].T


class FaceAffect:
    """One locked face, three new consistent frames, CPU-only local inference.

    ``session`` is an injectable ONNX-like test double. Production sessions load
    only pinned official model bytes and use the CPU EP. Default ``ferplus``
    preserves the existing grayscale contract; ``mobilefacenet`` is explicit.
    Construction failures become a sanitized unavailable snapshot, not an
    exception containing paths, samples, headers or model-provider diagnostics.
    """

    def __init__(self, model_path: str | Path, *, backend: str = "ferplus", session: Any = None):
        self._lock = threading.RLock()
        self._session = None
        self._load_error: str | None = None
        self._backend = backend
        self._cv2 = None
        self._side = 112 if backend == "mobilefacenet" else 64
        self._encoding = "jpeg-base64" if backend == "mobilefacenet" else "gray8-base64"
        self._classes = 7 if backend == "mobilefacenet" else 8
        self._input_name = self._output_name = ""
        self._boot: str | None = None
        self._track: int | None = None
        self._last_frame: int | None = None
        self._last_capture: int | None = None
        self._last_now: float | None = None
        self._candidate: str | None = None
        self._ema: tuple[float, ...] = ()
        self._history: list[tuple[float, tuple[float, ...]]] = []
        self._streak = 0
        self._estimate = FaceEstimate()
        try:
            if backend not in ("ferplus", "mobilefacenet"):
                self._load_error = "backend_unsupported"
            elif np is None:
                self._load_error = "dependencies_unavailable"
            else:
                if backend == "mobilefacenet":
                    try:
                        import cv2
                        self._cv2 = cv2
                    except ImportError:
                        self._load_error = "dependencies_unavailable"
                if not self._load_error:
                    self._session = session if session is not None else self._load(model_path)
            if self._session is not None:
                self._validate_session()
        except Exception:
            # Exception strings can retain implementation/provider details.
            self._session = None
            self._load_error = "model_initialization_failed"
        self.reset()

    def _load(self, model_path: str | Path) -> Any:
        try:
            import onnxruntime as ort
        except ImportError:
            self._load_error = "dependencies_unavailable"
            return None
        path = Path(model_path).expanduser()
        expected_size = MOBILEFACENET_SIZE if self._backend == "mobilefacenet" else MODEL_SIZE
        expected_hash = MOBILEFACENET_SHA256 if self._backend == "mobilefacenet" else MODEL_SHA256
        if not path.is_file() or path.stat().st_size != expected_size:
            self._load_error = "model_missing_or_wrong_size"
            return None
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        if digest.hexdigest() != expected_hash:
            self._load_error = "model_integrity_failed"
            return None
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.log_severity_level = 3
        return ort.InferenceSession(str(path), sess_options=options,
                                    providers=["CPUExecutionProvider"])

    def _validate_session(self) -> None:
        inputs, outputs = self._session.get_inputs(), self._session.get_outputs()
        if len(inputs) != 1 or len(outputs) != 1:
            raise ValueError("model_io_invalid")
        input_shape, output_shape = list(inputs[0].shape), list(outputs[0].shape)
        if (inputs[0].type != "tensor(float)" or len(input_shape) != 4
                or input_shape[1:] != [3 if self._backend == "mobilefacenet" else 1,
                                      self._side, self._side]
                or input_shape[0] not in (1, None, "N")
                or len(output_shape) != 2 or output_shape[1] != self._classes
                or output_shape[0] not in (1, None, "N")
                or outputs[0].type != "tensor(float)"):
            raise ValueError("model_io_invalid")
        self._input_name, self._output_name = inputs[0].name, outputs[0].name

    def _clear(self) -> None:
        self._boot = self._track = self._last_frame = self._last_capture = None
        self._candidate = None
        self._ema = ()
        self._history = []
        self._streak = 0

    def reset(self, reason: str = "reset") -> None:
        with self._lock:
            self._clear()
            self._last_now = None
            safe_reason = reason if reason in {
                "reset", "stopped", "boot_changed", "target_changed", "disconnected",
                "no_face", "ambiguous", "expired", "clock_reset", "device_changed",
            } else "reset"
            self._estimate = FaceEstimate(
                status="unavailable" if self._load_error else "unknown",
                reason=self._load_error or safe_reason)

    def _reject(self, status: str, reason: str) -> FaceEstimate:
        self._clear()
        self._estimate = FaceEstimate(status=status, reason=reason)
        return self._estimate

    def _retain_transport_gap(self, sample: dict) -> FaceEstimate | None:
        """Keep verified evidence across a proven same-target delivery gap.

        A gap never becomes evidence or a stable estimate. Original timestamps,
        expiry, support count and last verified frame/capture IDs stay intact.
        _snapshot has already expired old evidence; the next genuinely new
        valid observation still applies the original three-second window.
        """
        reason = _device_rejection(sample, "")
        age = _finite(sample.get("ageMs"))
        if (reason not in {"stale", "timeout"}
                or sample.get("ok") is not True or sample.get("pending") is not False
                or sample.get("valid") is not False or "pixels" in sample
                or self._boot is None or type(sample.get("bootId")) is not str
                or sample["bootId"] != self._boot
                or not _uint32(sample.get("trackId"), positive=True)
                or sample["trackId"] != self._track
                or sample.get("locked") is not True or sample.get("tracking") is not True
                or sample.get("ambiguous") is not False
                or type(sample.get("faces")) is not int or not 1 <= sample["faces"] <= 8
                or not _uint32(sample.get("frameId")) or not _uint32(sample.get("capturedMs"))
                or age is None or age > 0xFFFFFFFF
                or not self._format_matches(sample)
                or self._last_frame is None or self._last_capture is None
                or self._estimate.expires_at is None):
            return None
        # Even previously stable evidence is withheld until another fresh frame.
        # Keep the old expiry so repeated gaps cannot prolong its lifetime.
        self._estimate = replace(self._estimate, status="invalid_sample", stable=False,
                                 mood="unknown", expression="unknown", confidence=0.,
                                 margin=0., probabilities=(), reason=reason)
        return self._estimate

    def _format_matches(self, sample: dict) -> bool:
        return (type(sample.get("width")) is int and sample["width"] == self._side
                and type(sample.get("height")) is int and sample["height"] == self._side
                and sample.get("encoding") == self._encoding
                and sample.get("mirrored") is False)

    def _tensor(self, sample: dict) -> tuple[Any, str | None]:
        encoded = sample.get("pixels")
        if (not isinstance(encoded, str) or not 1 <= len(encoded) <= _ENCODED_SIZE
                or (self._backend == "ferplus" and len(encoded) != _ENCODED_SIZE)):
            return None, "sample_pixels_invalid"
        try:
            pixels = base64.b64decode(encoded, validate=True)
            if base64.b64encode(pixels).decode("ascii") != encoded:
                return None, "sample_pixels_invalid"
        except (ValueError, binascii.Error):
            return None, "sample_pixels_invalid"
        if self._backend == "ferplus":
            if len(pixels) != _PIXELS:
                return None, "sample_pixels_invalid"
            return np.frombuffer(pixels, dtype=np.uint8).reshape(1, 1, 64, 64).astype(np.float32), None
        if not _bounded_color_jpeg(pixels):
            return None, "sample_jpeg_invalid"
        points = _landmarks(sample.get("landmarks"))
        if points is None:
            return None, "sample_landmarks_invalid"
        try:
            # Landmark coordinates describe the wire raster, not EXIF display
            # orientation. Never let an embedded tag rotate/mirror that raster.
            image = self._cv2.imdecode(np.frombuffer(pixels, dtype=np.uint8),
                                       self._cv2.IMREAD_COLOR | self._cv2.IMREAD_IGNORE_ORIENTATION)
            if image is None or image.shape != (112, 112, 3) or image.dtype != np.uint8:
                return None, "sample_jpeg_invalid"
            aligned = self._cv2.warpAffine(image, _alignment_matrix(points), (112, 112),
                                            flags=self._cv2.INTER_LINEAR,
                                            borderMode=self._cv2.BORDER_CONSTANT, borderValue=0)
            rgb = self._cv2.cvtColor(aligned, self._cv2.COLOR_BGR2RGB).astype(np.float32) / np.float32(255.)
            rgb = (rgb - np.float32(.5)) / np.float32(.5)
            return np.ascontiguousarray(rgb.transpose(2, 0, 1)[None]), None
        except Exception:
            return None, "sample_preprocessing_failed"

    def _time(self, now: object) -> float | None:
        at = _finite(now)
        if at is None or (self._last_now is not None and at < self._last_now):
            self._last_now = None
            return None
        self._last_now = at
        return at

    def _snapshot(self, at: float) -> FaceEstimate:
        current = self._estimate
        if current.expires_at is not None and at >= current.expires_at:
            self._candidate = None
            self._ema = ()
            self._history = []
            self._streak = 0
            self._estimate = replace(current, status="stale", stable=False,
                                     mood="unknown", expression="unknown", confidence=0.,
                                     frames=0, reason="sample_expired", margin=0., probabilities=())
        return self._estimate

    def snapshot(self, now: float) -> FaceEstimate:
        with self._lock:
            at = self._time(now)
            if at is None:
                return self._reject("invalid_time", "monotonic_clock_invalid")
            return self._snapshot(at)

    def infer(self, sample: dict, now: float) -> FaceEstimate:
        with self._lock:
            at = self._time(now)
            if at is None:
                return self._reject("invalid_time", "monotonic_clock_invalid")
            if self._load_error or self._session is None:
                return self._reject("unavailable", self._load_error or "model_unavailable")
            self._snapshot(at)
            if type(sample) is not dict or sample.get("ok") is not True:
                return self._reject("invalid_sample", "sample_metadata_invalid")
            if type(sample.get("pending")) is not bool:
                return self._reject("invalid_sample", "sample_metadata_invalid")
            if sample.get("pending") is True:
                if ((self._boot is not None and sample.get("bootId") != self._boot)
                        or (self._track is not None and sample.get("trackId") != self._track)):
                    return self._reject("pending", "pending_target_changed")
                return self._snapshot(at)
            if sample.get("ambiguous") is True:
                return self._reject("ambiguous", _device_rejection(sample, "target_ambiguous"))
            if sample.get("locked") is not True or sample.get("tracking") is not True:
                return self._reject("no_face", _device_rejection(sample, "no_locked_tracked_face"))
            if sample.get("valid") is not True:
                gap = self._retain_transport_gap(sample)
                if gap is not None:
                    return gap
                return self._reject("invalid_sample", _device_rejection(sample, "device_rejected_sample"))
            boot, track = sample.get("bootId"), sample.get("trackId")
            frame, capture = sample.get("frameId"), sample.get("capturedMs")
            age = _finite(sample.get("ageMs"))
            if (not isinstance(boot, str) or not 1 <= len(boot) <= 80 or not boot.isascii()
                    or not _uint32(track, positive=True) or not _uint32(frame)
                    or not _uint32(capture) or age is None
                    or type(sample.get("faces")) is not int or not 1 <= sample["faces"] <= 8):
                return self._reject("invalid_sample", "sample_metadata_invalid")
            if age >= _MAX_AGE * 1000:
                return self._reject("stale", "device_sample_expired")
            if not self._format_matches(sample):
                return self._reject("invalid_sample", "sample_format_invalid")
            tensor, error = self._tensor(sample)
            if error:
                return self._reject("invalid_sample", error)
            if self._boot != boot or self._track != track:
                self._clear()
                self._boot, self._track = boot, track
            if self._last_frame is not None and (
                    not _newer(frame, self._last_frame)
                    or not _newer(capture, self._last_capture)):
                return replace(self._snapshot(at), reason="frame_not_new")
            try:
                result = self._session.run([self._output_name], {self._input_name: tensor})
                if not isinstance(result, (tuple, list)) or len(result) != 1:
                    return self._reject("inference_failed", "model_output_invalid")
                scores = np.asarray(result[0], dtype=np.float64)
                if scores.shape != (1, self._classes) or not np.isfinite(scores).all():
                    return self._reject("inference_failed", "model_output_invalid")
                logits = tuple(float(value) for value in scores[0])
                pivot = max(logits)
                weights = tuple(math.exp(value - pivot) for value in logits)
                total = sum(weights)
                probabilities = tuple(value / total for value in weights)
                if self._backend == "mobilefacenet":
                    mapped = [0.] * 8
                    for value, canonical in zip(probabilities, _MOBILE_TO_CANONICAL):
                        mapped[canonical] = value
                    probabilities = tuple(mapped)
            except Exception:
                return self._reject("inference_failed", "model_inference_failed")
            self._last_frame, self._last_capture = frame, capture
            observed = at - age / 1000.
            order = sorted(range(8), key=probabilities.__getitem__, reverse=True)
            index = order[0]
            expression = LABELS[index]
            confidence, margin = probabilities[index], probabilities[index] - probabilities[order[1]]
            common = dict(track_id=track, frame_id=frame, observed_at=observed,
                          expires_at=observed + _MAX_AGE, confidence=confidence,
                          margin=margin, probabilities=probabilities)
            if confidence < _MIN_CONFIDENCE or margin < _MIN_MARGIN:
                self._candidate, self._ema, self._streak = None, (), 0
                self._history = []
                self._estimate = FaceEstimate(status="unknown", reason="confidence_or_margin_low", **common)
            elif expression not in _MOODS:
                self._candidate, self._ema, self._streak = None, (), 0
                self._history = []
                self._estimate = FaceEstimate(status="unknown", expression=expression,
                                             reason="expression_not_mapped", **common)
            else:
                if self._candidate != expression:
                    self._history = []
                self._candidate = expression
                self._history = [(when, probability) for when, probability in self._history
                                 if observed - when < _MAX_AGE]
                self._history = (self._history + [(observed, probabilities)])[-_MIN_FRAMES:]
                self._ema = self._history[0][1]
                for _, probability in self._history[1:]:
                    self._ema = tuple(old + _EMA_ALPHA * (new - old)
                                      for old, new in zip(self._ema, probability))
                self._streak = len(self._history)
                smoothed = self._ema[index]
                stable = self._streak >= _MIN_FRAMES
                common.update(confidence=smoothed, probabilities=self._ema,
                              margin=smoothed - max(p for i, p in enumerate(self._ema) if i != index))
                self._estimate = FaceEstimate(
                    status="stable" if stable else "stabilizing", stable=stable,
                    mood=_MOODS[expression] if stable else "unknown", expression=expression,
                    frames=self._streak, reason="consistent_visible_expression" if stable
                    else "collecting_consistent_frames", **common)
            return self._estimate
