"""Exercise the real Hermes facade, core pool and context request dispatch."""
import json
import sys
import unittest
from contextlib import ExitStack, nullcontext
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'packages/server/src/modules/hermes/services/bridge/python'))
import bridge_pool
import bridge_server
import hermes_bridge


class GatewayRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        native = ModuleType('run_agent')

        class Agent:
            def __init__(self, **kwargs):
                self.kwargs = kwargs
                self.tools = []
                self.__dict__.update(kwargs)
                self.switch_model = Mock(side_effect=self.switch)

            def switch(self, **kwargs):
                self.model = kwargs.pop('new_model')
                self.provider = kwargs.pop('new_provider')
                self.__dict__.update(kwargs)

        native.AIAgent = Agent
        self.stack.enter_context(patch.dict(sys.modules, {'run_agent': native}))
        self.stack.enter_context(patch.object(hermes_bridge, '_sync_pool_patches'))
        self.legacy_runtime = Mock(return_value={'provider': 'legacy', 'api_key': 'legacy-unit-key'})
        self.stack.enter_context(patch.multiple(bridge_pool,
            _refresh_worker_profile_env=Mock(), _ensure_agent_imports=Mock(), _suppress_bridge_platform_hint=Mock(),
            _refresh_approval_allowlist=Mock(), _profile_env=lambda profile: nullcontext(), _discover_bridge_mcp_tools=lambda: [],
            _load_cfg=lambda: {}, _resolve_model=lambda cfg: 'native-model', _resolve_runtime=self.legacy_runtime,
            _load_fallback_model=lambda cfg: None, _cfg_max_turns=lambda *args: 90, _load_reasoning_config=lambda model: {},
            _load_service_tier=lambda: None, _load_enabled_toolsets=lambda: [], _load_disabled_toolsets=lambda: [],
            _mcp_tool_names_from_names=lambda names: names, _bridge_platform=lambda: 'test',
            _bind_session_workspace_cwd=lambda *args: False,
        ))
        self.pool = hermes_bridge.AgentPool()
        self.pool._db = SimpleNamespace(get_for_profile=lambda profile: None, error=None)
        for method in ['_install_compression_hook', '_install_prepersist_dedup_hook', '_install_boundary_interrupt']:
            setattr(self.pool, method, Mock())
        self.runtime = {'provider': 'custom', 'api_mode': 'codex_responses', 'base_url': 'http://127.0.0.1:18648/api/ekko-studio/models/v1', 'api_key': 'gateway-unit-key'}

    def get_session(self, runtime=None):
        return self.pool.get_or_create('session', profile='work', provider='ekkostudio', model='deepseek/model', gateway_runtime=runtime)

    def test_actual_facade_constructs_agent_with_gateway_credentials(self):
        session = self.get_session(self.runtime)
        self.assertEqual(session.agent.api_key, 'gateway-unit-key')
        self.assertEqual(session.agent.base_url, self.runtime['base_url'])
        self.assertEqual(session.agent.provider, 'custom')
        self.assertEqual(session.config['provider'], 'ekkostudio')
        self.assertNotIn('gateway-unit-key', json.dumps(session.config))
        self.legacy_runtime.assert_not_called()

    def test_existing_native_calls_without_override_keep_runtime_resolution(self):
        session = self.get_session()
        self.assertEqual(session.agent.api_key, 'legacy-unit-key')
        self.legacy_runtime.assert_called_once_with('deepseek/model', 'ekkostudio')

    def test_context_request_reaches_real_facade_and_pool_with_override(self):
        server = bridge_server.BridgeServer.__new__(bridge_server.BridgeServer)
        server.pool = self.pool
        self.pool._estimate_context_info = Mock(return_value={'token_count': 8, 'fixed_context_tokens': 2})
        result = server.handle({'action': 'context_estimate', 'session_id': 'session', 'profile': 'work', 'provider': 'ekkostudio', 'model': 'deepseek/model', 'gateway_runtime': self.runtime, 'messages': []})
        self.assertEqual(result['token_count'], 8)
        self.assertEqual(self.pool._sessions['session'].agent.api_key, 'gateway-unit-key')
        self.assertNotIn('gateway-unit-key', json.dumps(result))

    def test_deferred_model_switch_keeps_override_private_and_applies_it_when_idle(self):
        session = self.get_session(self.runtime)
        session.running = True
        result = self.pool.switch_session_model('session', 'deepseek/next', provider='ekkostudio', profile='work', gateway_runtime=self.runtime)
        self.assertTrue(result['deferred'])
        self.assertNotIn('gateway-unit-key', json.dumps(session.config))
        session.running = False
        self.pool._apply_pending_session_model_switch(session)
        self.assertEqual(session.agent.model, 'deepseek/next')
        self.assertEqual(session.agent.api_key, 'gateway-unit-key')
        self.assertIsNone(session.pending_gateway_runtime)


if __name__ == '__main__':
    unittest.main()
