"""Offline tests only: HTTP transport is mocked; no device/LLM is contacted."""
import asyncio
import base64
from contextlib import contextmanager
import json
import math
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, AsyncMock, call
from types import SimpleNamespace

import httpx
import pulse_mcp as bridge
from mcp.server.fastmcp.exceptions import ToolError
from pulse_mcp import Connection, DeviceClient, load_connection, mcp


TOKEN = "a" * 64  # Synthetic test credential, never an actual device token.


class ConnectionTests(unittest.TestCase):
    def test_private_file_and_no_secret_in_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "connection.json"
            path.write_text(json.dumps({"endpoint": "http://192.168.1.12", "control_token": TOKEN}))
            path.chmod(0o600)
            connection = load_connection(path)
            self.assertNotIn(TOKEN, repr(connection))
            path.chmod(0o644)
            with self.assertRaises(ToolError) as caught:
                load_connection(path)
            self.assertNotIn(TOKEN, str(caught.exception))
            path.chmod(0o600)
            alias = Path(directory) / "alias.json"
            alias.symlink_to(path)
            with self.assertRaises(ToolError):
                load_connection(alias)

    def test_refuses_credentials_in_url_and_public_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "connection.json"
            path.touch(mode=0o600)
            for endpoint in ("http://user:password@192.168.1.12", "http://8.8.8.8", "file:///tmp/device"):
                path.write_text(json.dumps({"endpoint": endpoint, "control_token": TOKEN}))
                with self.assertRaises(ToolError):
                    load_connection(path)


class ToolTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        bridge._behavior_lock = asyncio.Lock()
        bridge._behavior_tasks.clear()
        bridge._behavior_epoch = 0
        bridge._stops_inflight = 0
        bridge._face_task = None
        bridge._camera_lock = asyncio.Lock()
        bridge._scene_lock = asyncio.Lock()
        bridge._scene_tasks.clear()
        bridge._scene_inflight = 0
        bridge._scene_last = {"status": "not_started"}
        bridge._face_observations.update(stable_counts={}, confident_counts={}, last_visual_command=None)
        bridge._last_counted_face = None
        self.requests = []
        self.state = {"ok": True, "bootId": "test-boot", "active": True,
                      "turnId": "test-turn", "generation": 11, "rendered_emotion_id": "35"}
        self.catalog = {"ok": True, "states": [{"id": "10", "name": "开心"}],
                        "actions": [{"id": "nod"}]}
        self.catalog["states"].extend({"id": identifier} for identifier in ("16", "19", "21", "35"))
        self.catalog["actions"].extend({"id": identifier} for identifier in ("hop", "nod_slow"))
        bridge._affect.reset()
        bridge._affect_boot = None
        bridge._face_classifier = None
        bridge._face_enabled = False
        bridge._face_state = "not_started"
        bridge._semantic_until = 0

        def respond(request):
            self.assertEqual(request.headers["Authorization"], "Bearer " + TOKEN)
            self.requests.append(request)
            if request.url.path == "/api/capabilities":
                return httpx.Response(200, json=self.catalog)
            if request.url.path == "/api/status":
                return httpx.Response(200, json=self.state)
            body = json.loads(request.content)
            if "emotionId" in body:
                self.state["rendered_emotion_id"] = body["emotionId"]
            return httpx.Response(200, json={"ok": True, "status": "accepted",
                                             "commandId": body.get("commandId")})

        self.client = DeviceClient(Connection("http://192.168.1.12", TOKEN), httpx.MockTransport(respond))

    async def test_only_seven_bounded_tools_are_exposed(self):
        self.assertEqual({tool.name for tool in await mcp.list_tools()},
                         {"capabilities", "status", "set_emotion", "play_action", "stop",
                          "respond_to_emotion", "look_at_camera"})

    async def test_camera_frame_has_separate_fixed_route_and_binary_budget(self):
        # Program-generated JPEG marker bytes; decoder validation belongs to SceneVision.
        jpeg = b"\xff\xd8" + bytes(8192) + b"\xff\xd9"
        metadata = {"ok": True, "valid": True, "pending": False, "bootId": "boot-test",
                    "conversationId": "pulse-test-c0000000000000001", "requestId": 7,
                    "frameId": 31, "capturedMs": 120, "ageMs": 10, "width": 320,
                    "height": 240, "encoding": "jpeg", "mirrored": False, "rotation": 0}
        def respond(request):
            self.assertEqual(request.url.path, "/api/camera/frame")
            self.assertEqual(request.headers["Accept"], "image/jpeg")
            self.assertEqual(request.headers["Authorization"], "Bearer " + TOKEN)
            return httpx.Response(200, content=jpeg, headers={"content-type": "image/jpeg",
                "X-Pulse-Meta": base64.b64encode(json.dumps(metadata).encode()).decode()})
        client = DeviceClient(self.client.connection, httpx.MockTransport(respond))
        result = await client.request("GET", "/api/camera/frame", params={"requestId": 7})
        self.assertEqual(result.pop("_jpeg_bytes"), jpeg)
        self.assertEqual(result["frameId"], 31)
        self.assertNotIn("pixels", result)
        self.assertGreaterEqual(result["ageMs"], 10)

    async def test_look_at_camera_returns_only_fresh_same_turn_scene_text(self):
        import cv2
        import numpy as np
        ok, image = cv2.imencode(".jpg", np.full((240, 320, 3), 127, dtype=np.uint8))
        self.assertTrue(ok)
        jpeg = image.tobytes()
        logical = "pulse-test-c0000000000000001"
        self.state.update(conversationId=logical, voice_armed=True, recording=False)
        metadata = {"ok": True, "valid": True, "pending": False, "bootId": self.state["bootId"],
                    "conversationId": logical, "generation": 11, "requestId": 7, "frameId": 31, "capturedMs": 120,
                    "ageMs": 10, "width": 320, "height": 240, "encoding": "jpeg",
                    "mirrored": False, "rotation": 0}
        def respond(request):
            self.requests.append(request)
            if request.url.path == "/api/status":
                return httpx.Response(200, json=self.state)
            if request.method == "POST":
                return httpx.Response(202, json={"ok": True, "pending": True, "requestId": 7})
            return httpx.Response(200, content=jpeg, headers={"content-type": "image/jpeg",
                "X-Pulse-Meta": base64.b64encode(json.dumps(metadata).encode()).decode()})
        client = DeviceClient(self.client.connection, httpx.MockTransport(respond))
        scene = {"summary": "程序生成的灰色图像", "objects": [], "visible_text": [],
                 "people_count": 0, "limitations": []}
        service = SimpleNamespace(status=lambda: {"configured": True, "consent": True},
                                  infer=AsyncMock(return_value={"scene": scene,
                                      "metadata": {"boot_id": self.state["bootId"],
                                                   "conversation_id": logical, "frame_id": 31,
                                                   "captured_at_ms": 120, "age_ms": 10}, "elapsed_ms": 1}))
        with patch("scene_vision.SceneVision.from_environment", return_value=service), \
             patch.object(bridge, "load_connection", return_value=client.connection), \
             patch.object(bridge, "DeviceClient", return_value=client):
            result = await bridge.look_at_camera("刚才画面有什么？")
        self.assertTrue(result["ok"])
        self.assertEqual(result["scene"], scene)
        self.assertEqual(result["metadata"]["frame_id"], 31)
        self.assertLess(result["age_ms"], 15000)
        self.assertEqual(service.infer.await_args.args[0], jpeg)
        encoded = json.dumps(result, ensure_ascii=False)
        self.assertNotIn(TOKEN, encoded)
        self.assertNotIn(base64.b64encode(jpeg).decode(), encoded)
        self.assertNotIn("pixels", encoded)

    @contextmanager
    def camera_fixture(self):
        import cv2
        import numpy as np
        _, encoded = cv2.imencode(".jpg", np.full((240, 320, 3), 110, dtype=np.uint8))
        self.state.update(conversationId="pulse-test-c0000000000000001", voice_armed=True, recording=False)
        metadata = {"ok": True, "valid": True, "pending": False, "bootId": self.state["bootId"],
                    "conversationId": self.state["conversationId"], "generation": 11, "requestId": 7, "frameId": 31,
                    "capturedMs": 120, "ageMs": 10, "width": 320, "height": 240,
                    "encoding": "jpeg", "mirrored": False, "rotation": 0}
        scene = {"summary": "程序生成的灰色图像", "objects": [], "visible_text": [],
                 "people_count": 0, "limitations": []}
        result = {"scene": scene, "metadata": {"boot_id": self.state["bootId"],
                  "conversation_id": self.state["conversationId"], "frame_id": 31,
                  "captured_at_ms": 120, "age_ms": 10}, "elapsed_ms": 1}
        service = SimpleNamespace(status=lambda: {"configured": True, "consent": True},
                                  infer=AsyncMock(return_value=result))
        fixture = SimpleNamespace(service=service, metadata=metadata, jpeg=encoded.tobytes(),
                                  result=result, pending_gets=0)
        def respond(request):
            self.requests.append(request)
            if request.url.path == "/api/status":
                return httpx.Response(200, json=self.state)
            if request.url.path == "/api/control":
                self.state.update(active=False, voice_armed=False)
                return httpx.Response(200, json={"ok": True, "status": "accepted"})
            self.assertEqual(request.url.path, "/api/camera/frame")
            if request.method == "POST" or fixture.pending_gets:
                if request.method == "GET":
                    fixture.pending_gets -= 1
                return httpx.Response(202, json={"ok": True, "pending": True, "requestId": 7})
            return httpx.Response(200, content=fixture.jpeg, headers={"content-type": "image/jpeg",
                "X-Pulse-Meta": base64.b64encode(json.dumps(metadata).encode()).decode()})
        fixture.client = DeviceClient(self.client.connection, httpx.MockTransport(respond))
        with patch("scene_vision.SceneVision.from_environment", return_value=service), \
             patch.object(bridge, "load_connection", return_value=fixture.client.connection), \
             patch.object(bridge, "DeviceClient", return_value=fixture.client):
            yield fixture

    async def test_scene_consent_false_does_not_even_query_device(self):
        service = SimpleNamespace(status=lambda: {"configured": True, "consent": False})
        with patch("scene_vision.SceneVision.from_environment", return_value=service), \
             patch.object(bridge, "DeviceClient", side_effect=AssertionError("no device reads")):
            result = await bridge.look_at_camera("我手里有什么？")
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "consent_required")

    async def test_scene_question_and_schema_cannot_choose_origin_model_or_files(self):
        tools = {tool.name: tool for tool in await mcp.list_tools()}
        schema = tools["look_at_camera"].inputSchema
        self.assertEqual(set(schema["properties"]), {"question"})
        self.assertEqual(schema["properties"]["question"]["maxLength"], 200)
        with patch.object(bridge, "DeviceClient", side_effect=AssertionError("no device reads")):
            for question in ("", "   ", "x" * 201, None, 42):
                with self.subTest(question_type=type(question).__name__), self.assertRaises(ToolError):
                    await bridge.look_at_camera(question)

    async def test_scene_waits_for_multiple_pending_gets_without_using_face_crop(self):
        with self.camera_fixture() as fixture:
            fixture.pending_gets = 2
            result = await bridge.look_at_camera("画面有什么？")
        self.assertTrue(result["ok"])
        self.assertEqual(sum(r.method == "GET" and r.url.path == "/api/camera/frame" for r in self.requests), 3)
        self.assertFalse(any(r.url.path == "/api/face/sample" for r in self.requests))

    async def test_scene_wrong_boot_chat_request_or_expired_frame_never_reaches_model(self):
        for key, value in (("bootId", "other-boot"), ("conversationId", "other-chat"),
                           ("requestId", 99), ("ageMs", 1201), ("ageMs", math.nan),
                           ("frameId", True), ("capturedMs", -1)):
            with self.subTest(key=key), self.camera_fixture() as fixture:
                fixture.metadata[key] = value
                with self.assertRaises(ToolError):
                    await bridge.look_at_camera("画面有什么？")
                fixture.service.infer.assert_not_awaited()

    async def test_scene_checks_actual_jpeg_geometry_before_model(self):
        import cv2
        import numpy as np
        with self.camera_fixture() as fixture:
            _, encoded = cv2.imencode('.jpg', np.zeros((112, 112, 3), dtype=np.uint8))
            fixture.jpeg = encoded.tobytes()
            with self.assertRaises(ToolError):
                await bridge.look_at_camera("画面有什么？")
            fixture.service.infer.assert_not_awaited()

    async def test_scene_changed_context_during_model_discards_late_answer(self):
        for field, value in (("bootId", "boot-2"), ("conversationId", "chat-2"),
                             ("generation", 12), ("turnId", "turn-2"), ("active", False),
                             ("voice_armed", False), ("recording", True)):
            self.state.update(bootId="test-boot", generation=11, turnId="test-turn", active=True)
            with self.subTest(field=field), self.camera_fixture() as fixture:
                async def infer(*args, **kwargs):
                    self.state[field] = value
                    return fixture.result
                fixture.service.infer.side_effect = infer
                with self.assertRaises(ToolError):
                    await bridge.look_at_camera("画面有什么？")

    async def test_scene_stop_cancels_inference_without_reactivating_face_or_voice(self):
        started = asyncio.Event()
        with self.camera_fixture() as fixture:
            async def infer(*args, **kwargs):
                started.set()
                await asyncio.Event().wait()
            fixture.service.infer.side_effect = infer
            task = asyncio.create_task(bridge.look_at_camera("画面有什么？"))
            await asyncio.wait_for(started.wait(), 1)
            result = await asyncio.wait_for(bridge.stop(), .5)
            self.assertTrue(result["ok"])
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertEqual(bridge._scene_inflight, 0)
            self.assertFalse(bridge._face_enabled)
            self.assertFalse(self.state["voice_armed"])

    async def test_scene_no_face_tracking_is_not_a_light_or_scene_claim(self):
        with self.camera_fixture() as fixture:
            self.state["face_tracking"] = {"locked": True, "tracking": True, "targetVisible": True}
            state = await bridge.status()
            self.assertEqual(state["face_tracking"], self.state["face_tracking"])
            self.assertNotEqual(state["facial_affect"].get("status"), "tracking")
            self.assertNotIn("summary", state["scene_vision"])

    async def test_scene_exact_observation_expiry_discards_completed_model_reply(self):
        clock = [1000.0]
        with self.camera_fixture() as fixture, patch.object(bridge, "time", SimpleNamespace(monotonic=lambda: clock[0])):
            fixture.metadata["ageMs"] = 0
            async def infer(*args, **kwargs):
                clock[0] = 1015.0
                return fixture.result
            fixture.service.infer.side_effect = infer
            with self.assertRaises(ToolError):
                await bridge.look_at_camera("画面有什么？")
            self.assertNotEqual(bridge._scene_last["status"], "observed")

    async def test_scene_context_change_before_model_never_uploads(self):
        with self.camera_fixture() as fixture:
            changed = {**self.state, "generation": 12}
            with patch.object(fixture.client, "status", AsyncMock(side_effect=[dict(self.state), changed])):
                with self.assertRaises(ToolError):
                    await bridge.look_at_camera("画面有什么？")
            fixture.service.infer.assert_not_awaited()

    async def test_scene_sample_generation_must_match_current_turn(self):
        for generation in (10, True, None):
            with self.subTest(generation=generation), self.camera_fixture() as fixture:
                fixture.metadata["generation"] = generation
                with self.assertRaises(ToolError):
                    await bridge.look_at_camera("画面有什么？")
                fixture.service.infer.assert_not_awaited()

    async def test_scene_diagnostic_expires_when_generation_or_turn_changes(self):
        with self.camera_fixture():
            await bridge.look_at_camera("画面有什么？")
            self.assertEqual((await bridge.status())["scene_vision"]["status"], "observed")
            self.state["generation"] = 12
            self.assertEqual((await bridge.status())["scene_vision"]["status"], "context_changed")
            self.state["generation"] = 11
            self.state["turnId"] = "another-turn"
            self.assertEqual((await bridge.status())["scene_vision"]["status"], "context_changed")

    async def test_scene_describes_frame_without_requiring_a_face(self):
        with self.camera_fixture() as fixture:
            self.state["face_tracking"] = {"locked": False, "tracking": False, "targetVisible": False}
            result = await bridge.look_at_camera("桌面上有什么？")
        self.assertTrue(result["ok"])
        self.assertEqual(result["scene"]["people_count"], 0)

    async def test_scene_inference_exception_cannot_expose_credentials(self):
        with self.camera_fixture() as fixture:
            fixture.service.infer.side_effect = ValueError("unsafe provider body " + TOKEN)
            result = await bridge.look_at_camera("画面有什么？")
        self.assertFalse(result["ok"])
        self.assertNotIn(TOKEN, json.dumps(result))
        self.assertNotIn("unsafe provider body", json.dumps(result))

    async def test_camera_oversize_compressed_or_malformed_response_fails_closed(self):
        cases = [({"content-type": "image/jpeg"}, b"\xff\xd8" + bytes(65536) + b"\xff\xd9"),
                 ({"content-type": "image/jpeg", "X-Pulse-Meta": "!"}, b"\xff\xd8" + bytes(64) + b"\xff\xd9"),
                 ({"content-type": "image/jpeg", "content-encoding": "gzip"}, b"not gzip"),
                 ({"content-type": "image/jpeg", "content-length": "9999999999"}, bytes(64))]
        for headers, content in cases:
            with self.subTest(headers=list(headers)):
                client = DeviceClient(self.client.connection, httpx.MockTransport(
                    lambda request: httpx.Response(200, headers=headers, content=content)))
                with self.assertRaises(ToolError):
                    await client.request("GET", "/api/camera/frame", params={"requestId": 7})

    async def test_combined_expression_and_gesture_are_atomic_and_both_validated(self):
        await self.client.express(emotion_id="16", action_id="nod_slow", intensity=.35)
        posts = [json.loads(r.content) for r in self.requests if r.method == "POST"]
        self.assertEqual(len(posts), 1)
        self.assertEqual((posts[0]["emotionId"], posts[0]["actionId"]), ("16", "nod_slow"))
        with self.assertRaises(ToolError):
            await self.client.express(emotion_id="16", action_id="invented")
        self.assertEqual(sum(r.method == "POST" for r in self.requests), 1)

    def enable_cues(self):
        self.catalog["features"] = {"phase_anchored_expression": True}
        self.catalog["clips"] = [{"id": "home_joy"}, {"id": "home_hm"}]

    async def test_expression_action_and_sound_are_one_turn_bound_command(self):
        self.enable_cues()
        await self.client.express(emotion_id="19", action_id="nod", sound_id="home_joy",
                                  sound_gain=.25, action_timing="speech_start",
                                  expected_state=dict(self.state))
        posts = [json.loads(r.content) for r in self.requests if r.method == "POST"]
        self.assertEqual(len(posts), 1)
        self.assertEqual({k: posts[0][k] for k in ("emotionId", "actionId", "soundId", "soundGain",
                                                 "actionTiming", "soundTiming", "bootId", "turnId", "generation")},
                         dict(emotionId="19", actionId="nod", soundId="home_joy", soundGain=.25,
                              actionTiming="speech_start", soundTiming="after_speech", bootId="test-boot",
                              turnId="test-turn", generation=11))

    async def test_clip_only_does_not_invent_an_expression_or_head_gesture(self):
        self.enable_cues()
        await self.client.express(sound_id="home_hm", sound_timing="when_quiet")
        post = next(json.loads(r.content) for r in self.requests if r.method == "POST")
        self.assertNotIn("emotionId", post)
        self.assertNotIn("actionId", post)
        self.assertEqual(self.state["rendered_emotion_id"], "35")
        self.assertEqual(post["soundId"], "home_hm")

    async def test_unknown_clip_and_old_firmware_cannot_receive_new_cues(self):
        with self.assertRaises(ToolError):
            await self.client.express(action_id="nod", sound_id="home_joy")
        self.enable_cues()
        with self.assertRaises(ToolError):
            await self.client.express(action_id="nod", sound_id="invented_clip")
        for emotion in ("39", "41"):
            self.catalog["states"].append({"id": emotion})
            with self.assertRaises(ToolError):
                await self.client.express(emotion_id=emotion, sound_id="home_joy")
        self.assertFalse(any(r.method == "POST" for r in self.requests))

    async def test_cue_parameters_fail_before_any_io(self):
        for parameters in ({"sound_gain": float("nan")}, {"sound_gain": .601},
                           {"sound_gain": True}, {"sound_timing": {}},
                           {"action_timing": []}, {"sound_timing": "now"},
                           {"sound": True, "sound_id": "home_joy"}):
            with self.subTest(parameters=parameters), self.assertRaises(ToolError):
                await self.client.express(action_id="nod", **parameters)
        with self.assertRaises(ToolError):
            await self.client.express(sound_id="home_joy", action_timing="speech_start")
        self.assertEqual(self.requests, [])

    async def test_new_cue_is_not_sent_into_a_changed_turn(self):
        self.enable_cues()
        expected = dict(self.state)
        self.state["generation"] += 1
        with self.assertRaises(ToolError):
            await self.client.express(sound_id="home_joy", expected_state=expected)
        self.assertFalse(any(r.method == "POST" for r in self.requests))

    async def test_capability_semantics_only_describe_verified_device_resources(self):
        self.enable_cues()
        with patch.object(bridge, "load_connection", return_value=self.client.connection), \
             patch.object(bridge, "DeviceClient", return_value=self.client):
            result = await bridge.capabilities()
        for category in ("states", "actions", "clips"):
            self.assertEqual([item["id"] for item in result[category]],
                             [item["id"] for item in self.catalog[category]])
            self.assertTrue(all("semantics" in item for item in result[category]))
        for scene in result["director"]["scenes"]:
            self.assertIn(scene["emotion_id"], {item["id"] for item in self.catalog["states"]})
            self.assertTrue(scene.get("sound_id") is None or scene["sound_id"] in {"home_joy", "home_hm"})

    async def test_speech_anchoring_uses_actual_voice_reply_phase(self):
        self.enable_cues()
        bridge._affect_boot = self.state["bootId"]
        decision = SimpleNamespace(send=True, emotion_id="19", action_id="nod", strength=.25,
                                   duration_ms=20000, ttl_ms=25000, response_style="warm",
                                   reason="expression", scene_id="celebrate", sound_id="home_joy",
                                   sound_gain=.25, action_timing="speech_start")
        self.state.update(voice_armed=True, phase="思考中", listening=False, recording=False)
        with patch.object(bridge._affect, "plan", return_value=decision), \
             patch.object(bridge._affect, "commit", return_value=True):
            result = await bridge._dispatch_affect(self.client, self.state, "happy", .95, .7,
                                                   "conversation_text", "celebrate")
        post = next(json.loads(r.content) for r in self.requests if r.method == "POST")
        self.assertEqual((post["actionTiming"], post["soundTiming"]), ("speech_start", "after_speech"))
        self.assertEqual(result["scene_id"], "celebrate")
        self.assertFalse(result["physical_completion_confirmed"])

    async def test_visual_reference_never_plays_a_clip_or_waits_for_speech(self):
        self.enable_cues()
        bridge._affect_boot = self.state["bootId"]
        self.state.update(voice_armed=True, listening=True, recording=False, phase="正在听")
        decision = SimpleNamespace(send=True, emotion_id="19", action_id="nod", strength=.25,
                                   duration_ms=20000, ttl_ms=25000, response_style="warm",
                                   reason="expression", scene_id="happy", sound_id="home_joy",
                                   sound_gain=.25, action_timing="speech_start")
        with patch.object(bridge._affect, "plan", return_value=decision), \
             patch.object(bridge._affect, "commit", return_value=True):
            await bridge._dispatch_affect(self.client, self.state, "happy", .78, .4,
                                          "visible_face_expression")
        post = next(json.loads(r.content) for r in self.requests if r.method == "POST")
        self.assertNotIn("soundId", post)
        self.assertNotIn("actionTiming", post)
        self.assertIs(post["visualOnlyWhenListening"], True)

    async def test_audio_only_tool_does_not_protect_an_unrequested_visual_lease(self):
        self.enable_cues()
        with patch.object(bridge, "load_connection", return_value=self.client.connection), \
             patch.object(bridge, "DeviceClient", return_value=self.client), \
             patch.object(bridge._affect, "mark_explicit") as protect:
            await bridge.play_action(clip_id="home_joy")
        protect.assert_not_called()
        post = next(json.loads(r.content) for r in self.requests if r.method == "POST")
        self.assertEqual(post["soundId"], "home_joy")
        self.assertNotIn("emotionId", post)
        self.assertNotIn("actionId", post)

    async def test_armed_listening_clip_uses_quiet_gap_and_original_explicit_duration(self):
        self.enable_cues()
        self.state.update(voice_armed=True, phase="正在听", listening=True, recording=False)
        with patch.object(bridge, "load_connection", return_value=self.client.connection), \
             patch.object(bridge, "DeviceClient", return_value=self.client):
            await bridge.play_action(clip_id="home_joy")
            await bridge.play_action(clip_id="home_hm", duration_ms=3000, ttl_ms=4000)
        posts = [json.loads(r.content) for r in self.requests if r.method == "POST"]
        self.assertEqual((posts[0]["soundTiming"], posts[0]["durationMs"], posts[0]["ttlMs"]),
                         ("when_quiet", 20000, 25000))
        self.assertEqual((posts[1]["durationMs"], posts[1]["ttlMs"]), (3000, 4000))

    async def test_recording_prevents_new_head_motion_but_allows_a_deferred_audio_request(self):
        self.enable_cues()
        self.state.update(recording=True, voice_armed=True, phase="识别中")
        for values in ({"action_id": "nod"}, {"emotion_id": "19"}):
            with self.assertRaises(ToolError):
                await self.client.express(**values)
        self.assertFalse(any(r.method == "POST" for r in self.requests))
        await self.client.express(sound_id="home_hm")
        post = next(json.loads(r.content) for r in self.requests if r.method == "POST")
        self.assertNotIn("actionId", post)
        self.assertNotIn("emotionId", post)

    async def test_legacy_capabilities_explicitly_label_degraded_delivery(self):
        self.catalog["clips"] = [{"id": "home_joy"}, {"id": "home_final_nod"}]
        with patch.object(bridge, "load_connection", return_value=self.client.connection), \
             patch.object(bridge, "DeviceClient", return_value=self.client):
            result = await bridge.capabilities()
        self.assertFalse(result["director"]["phase_anchoring_available"])
        self.assertTrue(result["director"]["scenes"])
        self.assertTrue(all(scene["delivery"] == "legacy_visual_only"
                            and scene["effective_sound_id"] is None
                            and scene["effective_action_timing"] == "now"
                            for scene in result["director"]["scenes"]))

    async def test_stop_bypasses_a_slow_behavior_and_cancels_queued_old_requests(self):
        started = asyncio.Event()
        never = asyncio.Event()
        posted = []
        async def respond(request):
            if request.url.path == '/api/status':
                return httpx.Response(200, json=self.state)
            if request.url.path == '/api/capabilities':
                started.set()
                await never.wait()
                return httpx.Response(200, json=self.catalog)
            posted.append(json.loads(request.content))
            return httpx.Response(202, json={"ok": True})
        client = DeviceClient(self.client.connection, httpx.MockTransport(respond))
        with patch.object(bridge, 'load_connection', return_value=self.client.connection), \
             patch.object(bridge, 'DeviceClient', return_value=client):
            slow = asyncio.create_task(bridge.play_action('nod'))
            await asyncio.wait_for(started.wait(), 1)
            queued = asyncio.create_task(bridge.play_action('hop'))
            await asyncio.sleep(0)
            result = await asyncio.wait_for(bridge.stop(), .5)
            with self.assertRaises(asyncio.CancelledError):
                await slow
            with self.assertRaises(ToolError):
                await queued
        self.assertTrue(result['localCancellationTriggered'])
        self.assertEqual(posted, [{"method": "stop"}])
        self.assertEqual(bridge._behavior_tasks, set())

    async def test_stop_keeps_the_installed_face_monitor_alive(self):
        acquired = asyncio.Event()
        release = asyncio.Event()
        async def observer():
            async with bridge._behavior_scope():
                acquired.set()
                await release.wait()
                self.assertNotEqual(bridge._behavior_context_epoch.get(), bridge._behavior_epoch)
        task = asyncio.create_task(observer())
        bridge._face_task = task
        await acquired.wait()
        with patch.object(bridge, 'load_connection', return_value=self.client.connection), \
             patch.object(bridge, 'DeviceClient', return_value=self.client):
            await asyncio.wait_for(bridge.stop(), .5)
        self.assertFalse(task.cancelled())
        release.set()
        await task
        bridge._face_task = None

    async def test_face_observation_counters_only_count_distinct_valid_stable_frames(self):
        bridge._face_enabled = True
        bridge._affect_boot = self.state['bootId']
        self.state.update(voice_armed=True, listening=True, recording=False)
        estimate = SimpleNamespace(stable=True, expression='happiness', confidence=.95,
                                   status='stable', reason='consistent_visible_expression')
        bridge._face_classifier = SimpleNamespace(infer=lambda sample, now: estimate)
        ready = dict(ok=True, pending=False, valid=True, bootId=self.state['bootId'],
                     trackId=7, frameId=11, ageMs=100)
        client = SimpleNamespace(status=AsyncMock(return_value=self.state),
                                 request=AsyncMock(side_effect=[ready, ready, {**ready, 'valid': False},
                                                               {**ready, 'frameId': 12}]))
        with patch.object(bridge, 'load_connection', return_value=self.client.connection), \
             patch.object(bridge, 'DeviceClient', return_value=client), \
             patch.object(bridge, '_face_hint', return_value=None):
            for _ in range(4):
                await bridge._face_cycle()
        self.assertEqual(bridge._face_observations['stable_counts'], {'happiness': 2})
        self.assertEqual(bridge._face_observations['confident_counts'], {'happiness': 2})
        self.assertIsNone(bridge._face_observations['last_visual_command'])

    async def test_face_observation_history_is_not_presented_as_a_new_device_result(self):
        bridge._affect_boot = 'old-device'
        bridge._face_observations['stable_counts'] = {'happiness': 99}
        with patch.object(bridge, 'load_connection', return_value=self.client.connection), \
             patch.object(bridge, 'DeviceClient', return_value=self.client):
            result = await bridge.status()
        self.assertEqual(result['face_observations']['status'], 'device_changed')
        self.assertEqual(result['face_observations']['stable_counts'], {})

    async def test_adaptive_plan_cannot_bind_a_changed_turn(self):
        expected = dict(self.state)
        self.state["generation"] += 1
        with self.assertRaises(ToolError):
            await self.client.express(emotion_id="16", expected_state=expected)
        self.assertFalse(any(r.method == "POST" for r in self.requests))

    async def test_adaptive_sadness_is_gentle_concern_and_not_replayed(self):
        with patch.object(bridge, "load_connection", return_value=self.client.connection), \
             patch.object(bridge, "DeviceClient", return_value=self.client):
            first = await bridge.respond_to_emotion("sad", .95, .8)
            second = await bridge.respond_to_emotion("sad", .95, .8)
        self.assertEqual(first["status"], "accepted")
        self.assertEqual(first["emotion_id"], "16")
        self.assertEqual(first["action_id"], "nod_slow")
        self.assertLessEqual(first["intensity"], .55)
        self.assertFalse(first["physical_completion_confirmed"])
        self.assertEqual(second["status"], "kept")
        self.assertEqual(sum(r.method == "POST" for r in self.requests), 1)

    async def test_low_confidence_and_neutral_do_not_move_or_create_turn(self):
        self.state["active"] = False
        with patch.object(bridge, "load_connection", return_value=self.client.connection), \
             patch.object(bridge, "DeviceClient", return_value=self.client):
            await bridge.respond_to_emotion("sad", .3, .8)
            await bridge.respond_to_emotion("neutral", .95, .1)
        self.assertFalse(any(r.method == "POST" for r in self.requests))

    async def test_automatic_response_to_anger_never_uses_angry_face_or_shake(self):
        self.state["rendered_emotion_id"] = "10"
        with patch.object(bridge, "load_connection", return_value=self.client.connection), \
             patch.object(bridge, "DeviceClient", return_value=self.client):
            result = await bridge.respond_to_emotion("angry", .95, .9)
        self.assertEqual(result["emotion_id"], "35")
        self.assertEqual(result["intensity"], 0)
        self.assertIsNone(result["action_id"])
        post = next(json.loads(r.content) for r in self.requests if r.method == "POST")
        self.assertFalse(post["sound"])

    async def test_explicit_expression_is_protected_from_automatic_response(self):
        with patch.object(bridge, "load_connection", return_value=self.client.connection), \
             patch.object(bridge, "DeviceClient", return_value=self.client):
            await bridge.set_emotion("21", duration_ms=15000, ttl_ms=20000)
            result = await bridge.respond_to_emotion("sad", .95, .9)
        self.assertEqual(result["status"], "kept")
        self.assertEqual(sum(r.method == "POST" for r in self.requests), 1)

    async def test_failed_adaptive_send_does_not_commit_cooldown(self):
        with patch.object(bridge, "load_connection", return_value=self.client.connection), \
             patch.object(bridge, "DeviceClient", return_value=self.client):
            with patch.object(self.client, "express", side_effect=ToolError("rejected")):
                with self.assertRaises(ToolError):
                    await bridge.respond_to_emotion("happy", .95, .8)
            result = await bridge.respond_to_emotion("happy", .95, .8)
        self.assertEqual(result["status"], "accepted")

    async def test_device_reboot_clears_manual_protection(self):
        with patch.object(bridge, "load_connection", return_value=self.client.connection), \
             patch.object(bridge, "DeviceClient", return_value=self.client):
            await bridge.set_emotion("21")
            self.state["bootId"] = "new-boot"
            result = await bridge.respond_to_emotion("sad", .95, .8)
        self.assertEqual(result["status"], "accepted")

    async def test_clear_words_override_conflicting_visible_face(self):
        bridge._affect_boot = self.state["bootId"]
        value = {"stable": True, "mood": "happy", "confidence": .99}
        bridge._face_classifier = SimpleNamespace(snapshot=lambda now: SimpleNamespace(as_dict=lambda: value))
        with patch.object(bridge, "load_connection", return_value=self.client.connection), \
             patch.object(bridge, "DeviceClient", return_value=self.client):
            result = await bridge.respond_to_emotion("sad", .95, .8)
        self.assertEqual(result["input_source"], "conversation_text")
        self.assertEqual(result["emotion_id"], "16")

    async def test_face_hint_can_gently_fill_neutral_content(self):
        bridge._affect_boot = self.state["bootId"]
        self.state.update(voice_armed=True, listening=True, recording=False)
        value = {"stable": True, "mood": "happy", "confidence": .99}
        bridge._face_classifier = SimpleNamespace(snapshot=lambda now: SimpleNamespace(as_dict=lambda: value))
        with patch.object(bridge, "load_connection", return_value=self.client.connection), \
             patch.object(bridge, "DeviceClient", return_value=self.client):
            result = await bridge.respond_to_emotion("neutral", .95, .1)
        self.assertEqual(result["input_source"], "text_with_visible_face_hint")
        self.assertEqual(result["emotion_id"], "19")
        self.assertLessEqual(result["intensity"], .3)

    async def test_visual_hint_does_not_move_head_during_recording(self):
        bridge._affect_boot = self.state["bootId"]
        self.state.update(voice_armed=True, listening=True, recording=True)
        value = {"stable": True, "mood": "happy", "confidence": .99}
        bridge._face_classifier = SimpleNamespace(snapshot=lambda now: SimpleNamespace(as_dict=lambda: value))
        with patch.object(bridge, "load_connection", return_value=self.client.connection), \
             patch.object(bridge, "DeviceClient", return_value=self.client):
            result = await bridge.respond_to_emotion("neutral", .95, .1)
        self.assertEqual(result["input_source"], "conversation_text")
        self.assertFalse(any(r.method == "POST" for r in self.requests))

    async def test_visual_dispatch_rechecks_recording_after_planning(self):
        self.state.update(voice_armed=True, listening=True, recording=False)
        expected = dict(self.state)
        self.state["recording"] = True
        with self.assertRaises(ToolError):
            await self.client.express(emotion_id="19", expected_state=expected, require_visual_window=True)
        self.assertFalse(any(r.method == "POST" for r in self.requests))

    async def test_visual_dispatch_also_requires_device_side_listening_guard(self):
        self.state.update(voice_armed=True, listening=True, recording=False)
        await self.client.express(emotion_id="19", expected_state=dict(self.state), require_visual_window=True)
        post = next(json.loads(r.content) for r in self.requests if r.method == "POST")
        self.assertIs(post["visualOnlyWhenListening"], True)

    async def test_status_never_presents_previous_boot_face_estimate(self):
        bridge._face_enabled = True
        bridge._affect_boot = "previous-boot"
        bridge._face_classifier = SimpleNamespace(snapshot=lambda now: (_ for _ in ()).throw(
            AssertionError("must not read previous boot estimate")))
        with patch.object(bridge, "load_connection", return_value=self.client.connection), \
             patch.object(bridge, "DeviceClient", return_value=self.client):
            result = await bridge.status()
        self.assertFalse(result["facial_affect"]["stable"])
        self.assertEqual(result["facial_affect"]["status"], "device_changed")

    async def test_discovery_or_stopped_monitor_never_reads_camera(self):
        with patch.object(bridge, "DeviceClient", side_effect=AssertionError("must not read device")):
            await bridge._face_cycle()

    async def test_face_pending_poll_uses_boolean_contract_until_ready(self):
        bridge._face_enabled = True
        bridge._affect_boot = self.state["bootId"]
        self.state.update(voice_armed=True, listening=True, recording=False)
        received = []
        def infer(sample, now):
            received.append(sample)
            return SimpleNamespace(status="stabilizing")
        bridge._face_classifier = SimpleNamespace(
            infer=infer, snapshot=lambda now: SimpleNamespace(as_dict=lambda: {"stable": False}))
        pending = {"ok": True, "pending": True, "requestId": 7}
        ready = {"ok": True, "pending": False, "requestId": 7, "pixels": "synthetic-test-only"}
        client = SimpleNamespace(status=AsyncMock(return_value=self.state),
                                 request=AsyncMock(side_effect=[pending, pending, ready]))
        with patch.object(bridge, "load_connection", return_value=self.client.connection), \
             patch.object(bridge, "DeviceClient", return_value=client), \
             patch.object(bridge.asyncio, "sleep", new=AsyncMock()):
            await bridge._face_cycle()
        self.assertEqual(client.request.call_args_list, [
            call("POST", "/api/face/sample"),
            call("GET", "/api/face/sample", params={"requestId": 7}),
            call("GET", "/api/face/sample", params={"requestId": 7})])
        self.assertEqual(received, [ready])

    async def test_sampling_status_reports_safe_reject_diagnostics(self):
        bridge._face_enabled = True
        bridge._affect_boot = self.state["bootId"]
        self.state.update(voice_armed=True, listening=True, recording=False)
        bridge._face_classifier = SimpleNamespace(
            infer=lambda sample, now: SimpleNamespace(status="invalid_sample", reason="device_occlusion_suspected"),
            snapshot=lambda now: SimpleNamespace(as_dict=lambda: {"stable": False}))
        rejected = {"ok": True, "pending": False, "valid": False,
                    "trackId": 7, "frameId": 13, "ageMs": 180,
                    "pixels": "DO-NOT-EXPOSE", "reason": "untrusted-data"}
        client = SimpleNamespace(status=AsyncMock(return_value=self.state),
                                 request=AsyncMock(return_value=rejected))
        with patch.object(bridge, "load_connection", return_value=self.client.connection), \
             patch.object(bridge, "DeviceClient", return_value=client):
            await bridge._face_cycle()
        report = bridge._face_summary()["sampling"]
        self.assertEqual(report["last_result"], "rejected")
        self.assertEqual(report["last_reason"], "device_occlusion_suspected")
        self.assertEqual(report["last_frame_id"], 13)
        self.assertNotIn("DO-NOT-EXPOSE", json.dumps(report))
        self.assertNotIn("untrusted-data", json.dumps(report))

    async def test_face_get_202_is_allowed_without_relaxing_status_route(self):
        transport = httpx.MockTransport(lambda request: httpx.Response(
            202, json={"ok": True, "pending": True, "requestId": 1}))
        client = DeviceClient(Connection("http://192.168.1.12", TOKEN), transport)
        self.assertTrue((await client.request("GET", "/api/face/sample", params={"requestId": 1}))["pending"])
        with self.assertRaises(ToolError):
            await client.status()

    async def test_binary_face_sample_preserves_exact_pixels_and_metadata(self):
        pixels = bytes(range(256)) * 16  # Synthetic ramp, never a real face.
        metadata = {"ok": True, "pending": False, "valid": True, "status": "ready",
                    "width": 64, "height": 64, "encoding": "gray8-base64",
                    "frameId": 21, "trackId": 7}
        header = base64.b64encode(json.dumps(metadata).encode()).decode()
        def respond(request):
            self.assertEqual(request.headers["Accept"], "application/vnd.pulse.gray8")
            self.assertEqual(request.url.params["requestId"], "1")
            return httpx.Response(200, headers={"content-type": "application/vnd.pulse.gray8",
                                               "X-Pulse-Meta": header}, content=pixels)
        client = DeviceClient(Connection("http://192.168.1.12", TOKEN), httpx.MockTransport(respond))
        result = await client.request("GET", "/api/face/sample", params={"requestId": 1})
        self.assertEqual(base64.b64decode(result.pop("pixels")), pixels)
        self.assertEqual(result, metadata)

    async def test_modern_face_negotiation_requests_color_and_preserves_jpeg(self):
        # This is a generated flat-color test image, never an operator capture.
        import cv2
        import numpy as np
        ok, image = cv2.imencode('.jpg', np.full((112, 112, 3), 127, dtype=np.uint8))
        self.assertTrue(ok)
        pixels = image.tobytes()
        metadata = {"ok": True, "pending": False, "valid": True, "width": 112,
                    "height": 112, "encoding": "jpeg-base64",
                    "landmarks": [38., 51., 73., 51., 56., 72., 42., 92., 71., 92.]}
        header = base64.b64encode(json.dumps(metadata).encode()).decode()
        def respond(request):
            if request.method == 'POST':
                self.assertEqual(json.loads(request.content), {"format": "jpeg112"})
                return httpx.Response(202, json={"ok": True, "pending": True, "requestId": 7})
            self.assertEqual(request.headers['Accept'], 'image/jpeg')
            return httpx.Response(200, headers={"content-type": "image/jpeg", "X-Pulse-Meta": header},
                                  content=pixels)
        client = DeviceClient(self.client.connection, httpx.MockTransport(respond))
        with patch.dict(os.environ, {"PULSE_FACE_BACKEND": "mobilefacenet"}):
            await client.request('POST', '/api/face/sample')
            sample = await client.request('GET', '/api/face/sample', params={"requestId": 7})
        self.assertEqual(base64.b64decode(sample.pop('pixels')), pixels)
        self.assertEqual(sample, metadata)

    async def test_jpeg_sample_malformed_metadata_and_wire_fail_closed(self):
        metadata = {"ok": True, "pending": False, "valid": True, "width": 112,
                    "height": 112, "encoding": "jpeg-base64",
                    "landmarks": [38., 51., 73., 51., 56., 72., 42., 92., 71., 92.]}
        # Packet tests intentionally do not claim this synthetic byte sequence
        # is decodable; FaceAffect separately validates SOF before cv2.imdecode.
        pixels = b'\xff\xd8' + bytes(100) + b'\xff\xd9'
        cases = [({**metadata, "width": 64}, pixels),
                 ({**metadata, "encoding": "gray8-base64"}, pixels),
                 ({**metadata, "landmarks": [0.] * 9}, pixels),
                 ({**metadata, "landmarks": [True] + [0.] * 9}, pixels),
                 ({**metadata, "landmarks": [112.] + [0.] * 9}, pixels),
                 (metadata, pixels[:-2]), (metadata, b'\xff\xd8' + bytes(4093) + b'\xff\xd9')]
        for document, body in cases:
            header = base64.b64encode(json.dumps(document).encode()).decode()
            client = DeviceClient(self.client.connection, httpx.MockTransport(lambda request: httpx.Response(
                200, headers={"content-type": "image/jpeg", "X-Pulse-Meta": header}, content=body)))
            with patch.dict(os.environ, {"PULSE_FACE_BACKEND": "mobilefacenet"}), self.assertRaises(ToolError):
                await client.request('GET', '/api/face/sample', params={"requestId": 7})

    async def test_jpeg_is_never_accepted_from_a_status_or_control_route(self):
        client = DeviceClient(self.client.connection, httpx.MockTransport(lambda request: httpx.Response(
            200, headers={"content-type": "image/jpeg", "X-Pulse-Meta": "e30="},
            content=b'\xff\xd8' + bytes(100) + b'\xff\xd9')))
        with self.assertRaises(ToolError):
            await client.status()

    async def test_invalid_face_backend_does_not_fall_back_silently(self):
        with patch.dict(os.environ, {"PULSE_FACE_BACKEND": "untrusted_backend"}), self.assertRaises(ToolError):
            await self.client.request('GET', '/api/face/sample', params={"requestId": 7})
        self.assertEqual(self.requests, [])

    async def test_face_age_includes_receiving_a_slow_binary_body(self):
        metadata = {"ok": True, "pending": False, "valid": True, "width": 64,
                    "height": 64, "encoding": "gray8-base64", "ageMs": 100}
        header = base64.b64encode(json.dumps(metadata).encode()).decode()
        transport = httpx.MockTransport(lambda request: httpx.Response(
            200, headers={"content-type": "application/vnd.pulse.gray8", "X-Pulse-Meta": header},
            content=bytes(4096)))
        client = DeviceClient(Connection("http://192.168.1.12", TOKEN), transport)
        with patch.object(bridge, "time", SimpleNamespace(monotonic=iter((10., 13.25)).__next__)):
            result = await client.request("GET", "/api/face/sample", params={"requestId": 1})
        self.assertGreaterEqual(result["ageMs"], 3350)
        self.assertEqual(len(base64.b64decode(result["pixels"])), 4096)

    async def test_face_receipt_age_applies_to_legacy_json_but_not_rejections(self):
        ready = {"ok": True, "pending": False, "valid": True, "ageMs": 120}
        for metadata in (ready, {**ready, "valid": False, "reason": "stale"},
                         {**ready, "pending": True, "valid": False}):
            client = DeviceClient(Connection("http://192.168.1.12", TOKEN),
                                  httpx.MockTransport(lambda request: httpx.Response(200, json=metadata)))
            with patch.object(bridge, "time", SimpleNamespace(monotonic=iter((10., 11.75)).__next__)):
                result = await client.request("GET", "/api/face/sample", params={"requestId": 1})
            self.assertEqual(result["ageMs"], 1870 if metadata is ready else 120)

    async def test_receipt_age_does_not_repair_invalid_device_metadata(self):
        for age in (True, -1, 10 ** 400, "100"):
            document = {"ok": True, "pending": False, "valid": True, "ageMs": age}
            client = DeviceClient(Connection("http://192.168.1.12", TOKEN),
                                  httpx.MockTransport(lambda request: httpx.Response(200, json=document)))
            result = await client.request("GET", "/api/face/sample", params={"requestId": 1})
            self.assertEqual(result["ageMs"], age)
            self.assertIs(type(result["ageMs"]), type(age))

    async def test_malformed_binary_face_sample_fails_closed(self):
        valid = {"ok": True, "pending": False, "valid": True, "width": 64,
                 "height": 64, "encoding": "gray8-base64"}
        cases = [(valid, bytes(4095)), ({**valid, "width": 128}, bytes(4096)),
                 ({**valid, "pending": True}, bytes(4096)),
                 ({**valid, "pixels": "untrusted"}, bytes(4096))]
        for metadata, pixels in cases:
            header = base64.b64encode(json.dumps(metadata).encode()).decode()
            transport = httpx.MockTransport(lambda request: httpx.Response(
                200, headers={"content-type": "application/vnd.pulse.gray8", "X-Pulse-Meta": header}, content=pixels))
            client = DeviceClient(Connection("http://192.168.1.12", TOKEN), transport)
            with self.assertRaises(ToolError):
                await client.request("GET", "/api/face/sample", params={"requestId": 1})

    async def test_binary_payload_is_not_accepted_from_status_route(self):
        metadata = {"ok": True, "pending": False, "valid": True, "width": 64,
                    "height": 64, "encoding": "gray8-base64"}
        header = base64.b64encode(json.dumps(metadata).encode()).decode()
        transport = httpx.MockTransport(lambda request: httpx.Response(
            200, headers={"content-type": "application/vnd.pulse.gray8", "X-Pulse-Meta": header}, content=bytes(4096)))
        client = DeviceClient(Connection("http://192.168.1.12", TOKEN), transport)
        with self.assertRaises(ToolError):
            await client.status()

    async def test_binary_metadata_header_is_bounded_and_validated(self):
        for header in ("", "%invalid-base64", "A" * 2048, base64.b64encode(b"[]").decode()):
            transport = httpx.MockTransport(lambda request: httpx.Response(
                200, headers={"content-type": "application/vnd.pulse.gray8", "X-Pulse-Meta": header},
                content=bytes(4096)))
            client = DeviceClient(Connection("http://192.168.1.12", TOKEN), transport)
            with self.assertRaises(ToolError):
                await client.request("GET", "/api/face/sample", params={"requestId": 1})

    async def test_reads_live_catalog_and_turn_before_unique_command(self):
        for _ in range(2):
            await self.client.express(emotion_id="10")
        self.assertEqual([r.url.path for r in self.requests[:3]],
                         ["/api/capabilities", "/api/status", "/api/control"])
        first, second = [json.loads(r.content) for r in self.requests if r.method == "POST"]
        self.assertEqual(first["turnId"], "test-turn")
        self.assertEqual(first["generation"], 11)
        self.assertEqual(first["bootId"], "test-boot")
        self.assertNotEqual(first["commandId"], second["commandId"])
        self.assertEqual(len(first["commandId"]), 32)
        self.assertNotIn("expiresAtMs", first)

    async def test_idle_omits_old_turn_and_generation(self):
        self.state["active"] = False
        await self.client.express(action_id="nod")
        body = json.loads(self.requests[-1].content)
        self.assertNotIn("turnId", body)
        self.assertNotIn("generation", body)
        self.assertEqual(body["bootId"], "test-boot")

    async def test_unknown_id_never_posts_and_catalog_is_authoritative(self):
        with self.assertRaises(ToolError):
            await self.client.express(emotion_id="33")
        self.assertFalse(any(r.method == "POST" for r in self.requests))
        self.catalog["states"].append({"id": "33"})
        await self.client.express(emotion_id="33")
        self.assertEqual(json.loads(self.requests[-1].content)["emotionId"], "33")

    async def test_bounds_are_checked_before_network(self):
        for parameters in ({"intensity": math.nan}, {"intensity": 1.1}, {"intensity": True},
                           {"duration_ms": 30001}, {"duration_ms": 0}, {"ttl_ms": 0},
                           {"ttl_ms": 30001}, {"duration_ms": 100, "ttl_ms": 50}):
            with self.assertRaises(ToolError):
                await self.client.express(action_id="nod", **parameters)
        self.assertEqual(self.requests, [])

    async def test_missing_boot_or_active_fails_closed(self):
        self.state.pop("bootId")
        with self.assertRaises(ToolError):
            await self.client.express(action_id="nod")
        self.assertFalse(any(r.method == "POST" for r in self.requests))

    async def test_stop_does_not_open_a_turn(self):
        await self.client.stop()
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(json.loads(self.requests[0].content), {"method": "stop"})

    async def test_stop_accepts_202_but_does_not_claim_external_rollback(self):
        transport = httpx.MockTransport(lambda request: httpx.Response(202, json={"ok": True}))
        client = DeviceClient(Connection("http://192.168.1.12", TOKEN), transport)
        result = await client.stop()
        self.assertTrue(result["localCancellationTriggered"])
        self.assertFalse(result["externalTaskRollbackConfirmed"])

    async def test_get_still_requires_200(self):
        transport = httpx.MockTransport(lambda request: httpx.Response(202, json={"ok": True}))
        client = DeviceClient(Connection("http://192.168.1.12", TOKEN), transport)
        with self.assertRaises(ToolError):
            await client.status()

    async def test_redirect_does_not_forward_token_and_errors_do_not_echo_body(self):
        calls = []
        def respond(request):
            calls.append(request)
            return httpx.Response(302, headers={"location": "https://example.com"}, text=TOKEN)
        client = DeviceClient(Connection("http://192.168.1.12", TOKEN), httpx.MockTransport(respond))
        with self.assertRaises(ToolError) as caught:
            await client.status()
        self.assertEqual(len(calls), 1)
        self.assertNotIn(TOKEN, str(caught.exception))

    async def test_tool_output_redacts_returned_secrets(self):
        self.state.update(control_token=TOKEN, error="unexpected " + TOKEN)
        result = await self.client.status()
        self.assertNotIn(TOKEN, json.dumps(result))
        self.assertNotIn("control_token", result)



def _load_bridge_copy(toolset):
    """Import a separate copy of pulse_mcp with PULSE_MCP_TOOLSET set (registration happens at import)."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("pulse_mcp_" + toolset.replace(",", "_"),
                                                  Path(bridge.__file__))
    module = importlib.util.module_from_spec(spec)
    import sys
    sys.modules[spec.name] = module  # dataclasses resolve string annotations through sys.modules
    try:
        with patch.dict(os.environ, {"PULSE_MCP_TOOLSET": toolset}):
            spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(spec.name, None)
        raise
    return module


class NotifyTests(unittest.IsolatedAsyncioTestCase):
    """2.8: bounded task notices; the default voice tool list stays exactly seven."""

    def setUp(self):
        self.requests = []
        self.reply = (202, {"ok": True, "status": "queued", "kind": "task_done", "truncated": False, "pending": 1})

        def respond(request):
            self.assertEqual(request.headers["Authorization"], "Bearer " + TOKEN)
            self.requests.append(request)
            code, body = self.reply
            return httpx.Response(code, json=body)

        self.client = DeviceClient(Connection("http://192.168.1.12", TOKEN), httpx.MockTransport(respond))

    async def test_notice_is_one_bounded_post_to_the_fixed_route(self):
        result = await self.client.notify("task_done", "  周报写好了 ", notice_id="run-42")
        self.assertEqual(len(self.requests), 1)
        request = self.requests[0]
        self.assertEqual((request.method, request.url.path), ("POST", "/api/notify"))
        self.assertEqual(json.loads(request.content),
                         {"kind": "task_done", "title": "周报写好了", "source": "Ekko Studio", "id": "run-42"})
        self.assertEqual(result["status"], "queued")
        self.assertFalse(result["shown"])

    async def test_duplicate_is_success_but_unknown_status_is_not(self):
        self.reply = (200, {"ok": True, "status": "duplicate"})
        self.assertEqual((await self.client.notify("praise"))["status"], "duplicate")
        self.reply = (202, {"ok": True, "status": "shown_to_user"})
        with self.assertRaises(ToolError):
            await self.client.notify("praise")

    async def test_invalid_input_fails_before_any_io(self):
        for args, kwargs in ((("celebrate",), {}), (("task_done", "x" * 201), {}),
                             (("task_done", "bad\x00title"), {}), (("task_done", "ok", "s" * 25), {}),
                             (("task_done",), {"notice_id": "has space"}), (("task_done",), {"notice_id": "x" * 41}),
                             ((None,), {})):
            with self.assertRaises(ToolError):
                await self.client.notify(*args, **kwargs)
        self.assertEqual(self.requests, [])

    async def test_device_refusals_are_explained_without_echoing_secrets(self):
        for code, words in ((409, "任务提醒"), (429, "太频繁"), (400, "无效"), (404, "升级")):
            self.reply = (code, {"ok": False, "error": "x " + TOKEN})
            with self.assertRaises(ToolError) as caught:
                await self.client.notify("task_failed", "构建失败")
            self.assertIn(words, str(caught.exception))
            self.assertNotIn(TOKEN, str(caught.exception))

    async def test_default_toolset_is_unchanged_and_has_no_notify_tool(self):
        names = {tool.name for tool in await mcp.list_tools()}
        self.assertNotIn("notify_user", names)
        self.assertEqual(len(names), 7)

    async def test_notify_toolset_exposes_only_notify_user(self):
        copy = _load_bridge_copy("notify")
        tools = {tool.name: tool for tool in await copy.mcp.list_tools()}
        self.assertEqual(set(tools), {"notify_user"})
        schema = tools["notify_user"].inputSchema
        self.assertEqual(set(schema["properties"]), {"kind", "title", "notice_id"})
        self.assertEqual(schema["properties"]["kind"]["enum"], ["task_done", "task_failed", "reminder", "praise"])
        self.assertEqual(schema["properties"]["title"]["maxLength"], 64)
        self.assertEqual(schema["required"], ["kind"])
        both = _load_bridge_copy("voice,notify")
        self.assertEqual(len(await both.mcp.list_tools()), 8)

    async def test_notify_only_server_never_starts_the_face_monitor(self):
        copy = _load_bridge_copy("notify")
        with patch.object(copy, "_face_monitor", AsyncMock()) as monitor:
            async with copy._lifespan(copy.mcp):
                pass
        monitor.assert_not_called()

    def test_toolset_typo_fails_closed(self):
        for value in ("", "notfy", "voice,camera", ","):
            with self.assertRaises(SystemExit):
                _load_bridge_copy(value)

    async def test_notify_user_tool_uses_connection_file_and_fixed_source(self):
        copy = _load_bridge_copy("notify")
        sent = []

        async def fake_notify(self, kind, title="", source="", notice_id=None):
            sent.append((kind, title, source, notice_id))
            return {"ok": True, "status": "queued"}

        with patch.object(copy, "load_connection", return_value=Connection("http://192.168.1.12", TOKEN)), \
                patch.object(copy.DeviceClient, "notify", fake_notify):
            await copy.mcp.call_tool("notify_user", {"kind": "praise", "title": "今天好棒"})
        self.assertEqual(sent, [("praise", "今天好棒", "Ekko Studio", None)])


if __name__ == "__main__":
    unittest.main()
