"""Focused lifecycle tests using the actual Studio bridge and synthetic native MCP/Agent modules."""
import asyncio
import copy
import sys
import threading
import unittest
from contextlib import ExitStack, nullcontext
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'packages/server/src/modules/hermes/services/bridge/python'))
from bridge_broker import BridgeBroker
from bridge_pool import AgentPool, AgentSession, RunRecord
from bridge_server import BridgeServer
from bridge_transport import WorkerProcess
import bridge_pool
import bridge_server

SHARED = 'ekko-studio-plugins'
MANAGED = {'command': 'node', 'env': {'HERMES_WEB_UI_MANAGED_MCP': '1', 'HERMES_MCP_TOOLSET': 'plugins'}}


class Task:
    def __init__(self, names=()):
        self.closed = False
        self._registered_tool_names = list(names)
        self._tools = [SimpleNamespace(name=name) for name in names]
    async def shutdown(self): self.closed = True


class PluginMcpTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.bridge = BridgeServer('test-only')
        self.pool = self.bridge.pool
        self.config = {'mcp_servers': {SHARED: copy.deepcopy(MANAGED), 'external': {'command': 'user-owned'}}}
        self.servers = {name: Task() for name in [SHARED, 'old-tools', 'external']}
        self.available = {SHARED: ['peer__hello']}
        self.registry = {SHARED: ['deleted__hello', 'peer__hello'], 'old-tools': ['old__hello']}
        for name, tools in self.registry.items(): self.servers[name] = Task(tools)
        self.register = Mock(side_effect=self.register_servers)
        module = ModuleType('tools.mcp_tool')
        module._servers, module._lock = self.servers, threading.RLock()
        module._run_on_mcp_loop = lambda callback, timeout: asyncio.run(callback())
        discovery = ModuleType('tools.mcp_tool_discovery')
        discovery.register_mcp_servers = self.register
        discovery.discover_mcp_tools = lambda: None
        package = ModuleType('tools'); package.__path__ = []
        native = ModuleType('run_agent')
        registry = self.registry
        class Agent:
            def __init__(self, **kwargs):
                self.tools = [{'type': 'function', 'function': {'name': name}} for tools in registry.values() for name in tools]
                self.kwargs = kwargs
        native.AIAgent = Agent
        self.stack.enter_context(patch.dict(sys.modules, {'tools': package, 'tools.mcp_tool': module, 'tools.mcp_tool_discovery': discovery, 'run_agent': native}))
        self.stack.enter_context(patch.object(bridge_server, '_profile_env', lambda profile: nullcontext()))
        self.bridge._read_mcp_config = lambda profile: copy.deepcopy(self.config)
        self.bridge._save_mcp_config = lambda config, profile: setattr(self, 'config', copy.deepcopy(config))
        self.pool.has_active_background_for_session = Mock(return_value=False)
        self.stack.enter_context(patch.multiple(bridge_pool,
            _refresh_worker_profile_env=Mock(), _ensure_agent_imports=Mock(), _suppress_bridge_platform_hint=Mock(),
            _refresh_approval_allowlist=Mock(), _profile_env=lambda profile: nullcontext(), _discover_bridge_mcp_tools=lambda: list(self.registry),
            _load_cfg=lambda: {}, _resolve_model=lambda cfg: 'test-model', _resolve_runtime=lambda *args: {'provider': 'test'},
            _load_fallback_model=lambda cfg: None, _cfg_max_turns=lambda *args: 90, _load_reasoning_config=lambda model: {},
            _load_service_tier=lambda: None, _load_enabled_toolsets=lambda: [], _load_disabled_toolsets=lambda: [],
            _mcp_tool_names_from_names=lambda names: names,
        ))
        self.pool._db = SimpleNamespace(get_for_profile=lambda profile: None, error=None)
        for method in ['_install_compression_hook', '_install_prepersist_dedup_hook', '_install_boundary_interrupt']:
            setattr(self.pool, method, Mock())

    def register_servers(self, configs):
        for name in configs:
            self.servers[name] = Task(self.available.get(name, []))
            self.registry[name] = list(self.available.get(name, []))
        # Keep stale native registry entries deliberately; the model snapshot must filter them.

    def change(self, names=None, removed=None):
        return self.bridge.handle({'action': 'mcp_plugins_changed', 'servers': names or [SHARED, 'old-tools'], 'removed': removed or ['old-tools'], 'profile': 'work'})

    def test_removes_deleted_config_transport_and_keeps_shared_and_external(self):
        old, shared, external = (self.servers[name] for name in ['old-tools', SHARED, 'external'])
        self.assertFalse(self.change()['deferred'])
        self.assertTrue(old.closed); self.assertTrue(shared.closed); self.assertFalse(external.closed)
        self.assertNotIn('old-tools', self.servers)
        self.assertIn(SHARED, self.config['mcp_servers'])
        self.assertEqual(self.register.call_args.args[0], {SHARED: MANAGED})

    def test_preserves_an_external_same_name_server(self):
        self.config['mcp_servers']['old-tools'] = {'command': 'external-collision'}
        old = self.servers['old-tools']
        self.change()
        self.assertFalse(old.closed)
        self.assertEqual(self.config['mcp_servers']['old-tools']['command'], 'external-collision')

    def test_preserves_external_transport_ownership_even_after_its_config_is_gone(self):
        old = self.servers['old-tools']
        old._config = {'command': 'user-owned'}
        self.change()
        self.assertFalse(old.closed)
        self.assertIs(self.servers['old-tools'], old)

    def test_defers_foreground_and_background_work_then_cleans_at_idle(self):
        session = AgentSession('session', SimpleNamespace(tools=['old']), running=True)
        self.pool._sessions['session'] = session
        old = self.servers['old-tools']
        self.assertTrue(self.change()['deferred']); self.assertFalse(old.closed)
        session.running = False
        self.pool.has_active_background_for_session.return_value = True
        self.assertFalse(self.pool.refresh_mcp_if_idle()); self.assertFalse(old.closed)
        self.pool.has_active_background_for_session.return_value = False
        self.assertTrue(self.pool.refresh_mcp_if_idle()); self.assertTrue(old.closed)

    def test_disabled_plugin_services_remain_configured_but_are_not_restarted(self):
        self.config['mcp_servers'][SHARED]['enabled'] = False
        self.change()
        self.assertIn(SHARED, self.config['mcp_servers']); self.assertNotIn(SHARED, self.servers)
        self.register.assert_not_called()

    def test_rebuilds_only_idle_agent_snapshot_and_preserves_session_history_and_runs(self):
        session = self.pool.get_or_create('session', profile='work')
        old_agent = session.agent
        session.history = [{'role': 'user', 'content': 'Keep my conversation'}]
        session.background_events.append({'event': 'completed'})
        session.config['goal'] = 'Keep my goal'
        record = RunRecord('old-run', 'session', status='complete'); self.pool._runs['old-run'] = record
        session.running = True
        self.change()
        self.assertIs(self.pool.get_or_create('session', profile='work').agent, old_agent)
        session.running = False
        result = self.pool.get_or_create('session', profile='work')
        self.assertIs(result, session); self.assertIsNot(result.agent, old_agent)
        names = [tool['function']['name'] for tool in result.agent.tools]
        self.assertEqual(names, ['peer__hello'])
        self.assertEqual(result.history, [{'role': 'user', 'content': 'Keep my conversation'}])
        self.assertEqual(result.config['goal'], 'Keep my goal')
        self.assertEqual(result.background_events, [{'event': 'completed'}])
        self.assertIs(self.pool._runs['old-run'], record)
        self.assertTrue(result.config['mcp_restore_history'])
        self.pool._install_usage_hook = Mock()
        self.pool._bridge_context_ready_event = Mock(return_value=None)
        with patch.object(bridge_pool.threading, 'Thread') as thread:
            self.pool.start_chat('session', 'Continue', profile='work')
            self.assertEqual(thread.call_args.kwargs['args'][5], result.history)
            thread.return_value.start.assert_called_once()
        self.assertNotIn('mcp_restore_history', result.config)

    def test_failed_discovery_stays_pending_for_retry(self):
        self.register.side_effect = RuntimeError('Discovery failed')
        self.assertTrue(self.change()['deferred'])
        self.assertEqual(self.pool._mcp_generation, 0)
        self.register.side_effect = self.register_servers
        self.assertTrue(self.pool.refresh_mcp_if_idle())
        self.assertEqual(self.pool._mcp_generation, 1)

    def test_late_live_registration_is_kept_while_retired_definitions_are_filtered(self):
        self.pool._retired_mcp_tools = {'removed__hello', 'live__hello'}
        self.servers[SHARED] = Task(['live__hello'])
        agent = SimpleNamespace(tools=[{'name': 'removed__hello'}, {'name': 'live__hello'}, {'name': 'terminal'}])
        self.pool._filter_retired_mcp_tools(agent)
        self.assertEqual(agent.tools, [{'name': 'live__hello'}, {'name': 'terminal'}])

    def test_reinstall_while_deferred_cancels_obsolete_removal(self):
        session = AgentSession('session', SimpleNamespace(), running=True)
        self.pool._sessions['session'] = session
        self.change()
        self.config['mcp_servers']['old-tools'] = copy.deepcopy(MANAGED)
        self.bridge.handle({'action': 'mcp_plugins_changed', 'servers': ['old-tools'], 'removed': [], 'profile': 'work'})
        session.running = False
        self.assertTrue(self.pool.refresh_mcp_if_idle())
        self.assertIn('old-tools', self.config['mcp_servers']); self.assertIn('old-tools', self.servers)

    def test_run_completion_applies_deferred_cleanup_without_interrupting_the_run(self):
        session = AgentSession('session', SimpleNamespace(), running=True)
        record = RunRecord('run', 'session')
        self.pool._sessions['session'] = session
        self.change()
        def complete(*args): session.running = False; record.status = 'complete'
        self.pool._run_chat_inner = complete
        self.pool._run_chat(session, record, 'message')
        self.assertEqual(record.status, 'complete'); self.assertNotIn('old-tools', self.servers)

    def test_broadcast_reaches_isolated_workers_without_starting_absent_workers(self):
        broker = BridgeBroker('test-only')
        one = SimpleNamespace(running=True, profile='work', request=Mock(return_value={'ok': True}))
        isolated = SimpleNamespace(running=True, profile='work', request=Mock(return_value={'ok': True, 'deferred': True}))
        dead = SimpleNamespace(running=False, profile='private', request=Mock())
        broker._workers = {'work': one, 'group-isolated': isolated, 'dead': dead}
        broker._worker_for_profile = Mock(side_effect=AssertionError('Must not start a worker'))
        request = {'action': 'mcp_plugins_changed', 'servers': [SHARED], 'removed': []}
        result = broker.handle(request)
        self.assertTrue(result['ok']); self.assertEqual(len(result['workers']), 2)
        for worker in [one, isolated]: worker.request.assert_called_once_with(request, start_if_needed=False)
        dead.request.assert_not_called()
        one.request.side_effect = RuntimeError('One worker failed')
        result = broker.handle(request)
        self.assertFalse(result['ok']); self.assertEqual(isolated.request.call_count, 2)

    def test_passive_notification_never_starts_a_dead_worker(self):
        worker = WorkerProcess('work', 'work', 'test-only', None, None)
        worker.start = Mock(side_effect=AssertionError('Must not start a worker'))
        self.assertEqual(worker.request({'action': 'mcp_plugins_changed'}, start_if_needed=False), {'ok': True, 'skipped': True})
        worker.start.assert_not_called()


if __name__ == '__main__':
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(PluginMcpTests))
    if not result.wasSuccessful(): sys.exit(1)
    print('Hermes plugin MCP lifecycle verified')
