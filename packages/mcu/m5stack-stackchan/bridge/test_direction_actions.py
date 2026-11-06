"""Seven-tool bridge direction regression: mocked HTTP and local stdio only."""
import asyncio
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import httpx
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.server.fastmcp.exceptions import ToolError

import pulse_mcp as bridge
from expression_catalog import ACTIONS, SCENES


DIRECTIONS = ("look_left", "look_right", "look_up", "look_down")
LEGACY_ACTIONS = tuple("nod nod3 nod_slow shake hm look_around hey hop giggle dance dizzy surprise "
                       "jolt droop wake shy proud sigh listen broadcast send think recall search panic "
                       "angry stop talk busy stretch pet track daze sad tired focus meh boot error "
                       "look_up flinch".split())
VOICE_TOOLS = {"capabilities", "status", "set_emotion", "play_action", "respond_to_emotion",
               "look_at_camera", "stop"}


class DirectionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        bridge._behavior_lock = asyncio.Lock()
        bridge._behavior_tasks.clear()
        bridge._behavior_epoch = 0
        bridge._stops_inflight = 0
        bridge._affect.reset()
        bridge._affect_boot = None
        self.requests = []
        self.on_capabilities = None
        self.catalog = {"ok": True, "actions": [{"id": item.id} for item in ACTIONS]}
        self.state = {"ok": True, "bootId": "direction-test-boot", "active": True,
                      "turnId": "direction-test-turn", "generation": 12, "recording": False}

        def respond(request):
            self.requests.append(request)
            if request.method == "GET" and request.url.path == "/api/capabilities":
                if self.on_capabilities is not None:
                    self.on_capabilities()
                return httpx.Response(200, json=self.catalog)
            if request.method == "GET" and request.url.path == "/api/status":
                return httpx.Response(200, json=self.state)
            if request.method == "POST" and request.url.path == "/api/control":
                body = json.loads(request.content)
                return httpx.Response(200, json={"ok": True, "status": "accepted",
                                                "commandId": body["commandId"]})
            raise AssertionError("Unexpected route in mocked direction request")

        self.client = bridge.DeviceClient(bridge.Connection("http://127.0.0.1", "c" * 64),
                                          httpx.MockTransport(respond))

    async def test_same_seven_tools_and_same_bounded_action_parameters(self):
        with patch.object(bridge, "load_connection", side_effect=AssertionError("listing read credentials")):
            tools = await bridge.mcp.list_tools()
        self.assertEqual({tool.name for tool in tools}, VOICE_TOOLS)
        action = next(tool for tool in tools if tool.name == "play_action")
        self.assertEqual(set(action.inputSchema["properties"]),
                         {"action_id", "intensity", "duration_ms", "ttl_ms", "clip_id", "sound_gain"})
        for identifier in DIRECTIONS:
            self.assertIn(identifier, action.description)

    async def test_four_directions_send_only_action_and_preserve_original_default_or_voice_lease(self):
        with patch.object(bridge, "load_connection", return_value=self.client.connection), \
             patch.object(bridge, "DeviceClient", return_value=self.client):
            for identifier in DIRECTIONS:
                for parameters, duration in (({}, 3500), ({"duration_ms": 3000, "ttl_ms": 5000}, 3000)):
                    with self.subTest(action=identifier, parameters=parameters):
                        self.requests.clear()
                        await bridge.mcp.call_tool("play_action", {"action_id": identifier, **parameters})
                        self.assertEqual([request.url.path for request in self.requests],
                                         ["/api/status", "/api/capabilities", "/api/status", "/api/control"])
                        posts = [request for request in self.requests if request.method == "POST"]
                        self.assertEqual(len(posts), 1)
                        body = json.loads(posts[0].content)
                        self.assertEqual(body, {"method": "express", "commandId": body["commandId"],
                                               "bootId": "direction-test-boot", "turnId": "direction-test-turn",
                                               "generation": 12, "actionId": identifier, "intensity": .9,
                                               "durationMs": duration, "ttlMs": 5000, "sound": False})

    async def test_unflashed_or_unknown_directions_are_never_advertised_or_posted(self):
        self.catalog["actions"] = [{"id": "nod"}, {"id": "look_up"}]
        with patch.object(bridge, "load_connection", return_value=self.client.connection), \
             patch.object(bridge, "DeviceClient", return_value=self.client):
            actual = await bridge.capabilities()
            self.assertEqual([item["id"] for item in actual["actions"]], ["nod", "look_up"])
            self.assertTrue(all("semantics" in item for item in actual["actions"]))
            for identifier in ("look_left", "look_right", "look_down", "turn_any_angle"):
                with self.subTest(action=identifier), self.assertRaises(ToolError):
                    await bridge.play_action(identifier, duration_ms=3000, ttl_ms=5000)
            self.assertFalse(any(request.method == "POST" for request in self.requests))
            result = await bridge.play_action("look_up", duration_ms=3000, ttl_ms=5000)
            self.assertEqual(result["status"], "accepted")
            self.assertEqual(json.loads(self.requests[-1].content)["actionId"], "look_up")

    async def test_all_legacy_action_ids_and_dispatch_remain_compatible(self):
        self.assertEqual(tuple(item.id for item in ACTIONS[:len(LEGACY_ACTIONS)]), LEGACY_ACTIONS)
        self.assertEqual(tuple(item.id for item in ACTIONS[len(LEGACY_ACTIONS):]),
                         ("look_left", "look_right", "look_down"))
        with patch.object(bridge, "load_connection", return_value=self.client.connection), \
             patch.object(bridge, "DeviceClient", return_value=self.client):
            for identifier in LEGACY_ACTIONS:
                with self.subTest(action=identifier):
                    self.requests.clear()
                    await bridge.play_action(identifier)
                    posts = [request for request in self.requests if request.method == "POST"]
                    self.assertEqual(len(posts), 1)
                    self.assertEqual(json.loads(posts[0].content)["actionId"], identifier)

    async def test_directions_keep_recording_and_duration_guards(self):
        with patch.object(bridge, "load_connection", return_value=self.client.connection), \
             patch.object(bridge, "DeviceClient", return_value=self.client):
            for identifier in DIRECTIONS:
                self.requests.clear()
                self.state["recording"] = True
                with self.subTest(action=identifier), self.assertRaises(ToolError):
                    await bridge.play_action(identifier, duration_ms=3000, ttl_ms=5000)
                self.assertFalse(any(request.method == "POST" for request in self.requests))
            self.state["recording"] = False
            for parameters in ({"duration_ms": 30001}, {"duration_ms": 6000, "ttl_ms": 5000}):
                self.requests.clear()
                with self.assertRaises(ToolError):
                    await bridge.play_action("look_left", **parameters)
                self.assertFalse(any(request.method == "POST" for request in self.requests))
            await bridge.play_action("look_right", duration_ms=8000)
            body = json.loads(self.requests[-1].content)
            self.assertEqual((body["durationMs"], body["ttlMs"]), (8000, 8000))

    async def test_changed_turn_or_stop_epoch_prevents_late_direction_post(self):
        def changed_turn():
            self.state["generation"] += 1

        def stopped():
            bridge._behavior_epoch += 1

        with patch.object(bridge, "load_connection", return_value=self.client.connection), \
             patch.object(bridge, "DeviceClient", return_value=self.client):
            for hook in (changed_turn, stopped):
                for identifier in DIRECTIONS:
                    self.requests.clear()
                    self.on_capabilities = hook
                    with self.subTest(action=identifier, event=hook.__name__), self.assertRaises(ToolError):
                        await bridge.play_action(identifier, duration_ms=3000, ttl_ms=5000)
                    self.assertFalse(any(request.method == "POST" for request in self.requests))

    async def test_idle_direction_uses_boot_without_reusing_closed_turn_identity(self):
        self.state["active"] = False
        with patch.object(bridge, "load_connection", return_value=self.client.connection), \
             patch.object(bridge, "DeviceClient", return_value=self.client):
            for identifier in DIRECTIONS:
                await bridge.play_action(identifier, duration_ms=3000, ttl_ms=5000)
                body = json.loads(self.requests[-1].content)
                self.assertEqual(body["bootId"], "direction-test-boot")
                self.assertEqual(body["actionId"], identifier)
                self.assertNotIn("turnId", body)
                self.assertNotIn("generation", body)

    async def test_directions_remain_explicit_hold_resources_outside_automatic_scenes(self):
        resources = {item.id: item for item in ACTIONS}
        for identifier in DIRECTIONS:
            with self.subTest(action=identifier):
                resource = resources[identifier]
                self.assertTrue(resource.hold)
                self.assertFalse(resource.automatic)
                self.assertEqual(resource.allowed_modes, ("explicit", "local"))
                self.assertIn("ordinary_chat_auto", resource.disabled_when)
                self.assertNotIn(identifier, {scene.action_id for scene in SCENES.values()})


class LocalDiscoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_stdio_discovery_keeps_voice_notify_and_combined_isolated(self):
        with tempfile.TemporaryDirectory(prefix="direction29-mcp-discovery-") as directory:
            for toolset, expected in (("voice", VOICE_TOOLS), ("notify", {"notify_user"}),
                                      ("voice,notify", VOICE_TOOLS | {"notify_user"})):
                parameters = StdioServerParameters(command=sys.executable,
                    args=["-I", "-B", str(Path(bridge.__file__).resolve())],
                    env={"PULSE_MCP_TOOLSET": toolset,
                         "PULSE_CONNECTION_FILE": str(Path(directory) / "nonexistent.json")})
                async with stdio_client(parameters) as (reader, writer):
                    async with ClientSession(reader, writer) as session:
                        await session.initialize()
                        result = await session.list_tools()
                        self.assertEqual({tool.name for tool in result.tools}, expected)
                        if toolset != "notify":
                            tool = next(tool for tool in result.tools if tool.name == "play_action")
                            for identifier in DIRECTIONS:
                                self.assertIn(identifier, tool.description)


if __name__ == "__main__":
    unittest.main()
