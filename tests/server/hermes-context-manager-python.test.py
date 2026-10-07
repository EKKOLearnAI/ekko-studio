import json
import contextlib
import contextvars
import concurrent.futures
import os
import ssl
import subprocess
import sys
import tempfile
import types
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

SCRATCH_DIR = os.environ.get('TMPDIR')
REAL_HERMES_ROOT = Path(os.environ.get('HERMES_AGENT_ROOT') or
                        Path(__file__).resolve().parents[4] / 'hermes-agent')

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'packages/server/src/modules/hermes/services/bridge/python'))


def public_manifest_fixture(*extra_tools):
    names = ['compress', 'decompress', 'search_context', 'acp_status', 'acp_cache', *extra_tools]
    return {'ok': True, 'protocolVersion': 1,
            'headers': {'conversation': 'x-bili-plugin-conversation'}, 'toolNames': names,
            'tools': {'anthropic': [{'name': name, 'input_schema': {'type': 'object'}} for name in names]}}


class ContextManagerTests(unittest.TestCase):
    def setUp(self):
        # Bridge imports and profile entry must never bootstrap production plugins.
        self.isolation = contextlib.ExitStack()
        self.addCleanup(self.isolation.close)
        self.isolation.enter_context(patch.dict(os.environ, {}, clear=True))
        home = self.isolation.enter_context(tempfile.TemporaryDirectory(dir=SCRATCH_DIR))
        self.isolation.enter_context(patch.dict(os.environ, {'HERMES_HOME': home}))
        self.isolation.enter_context(patch('bridge_server._ensure_agent_imports'))
        self.isolation.enter_context(patch('bridge_server._profile_env', side_effect=lambda _: contextlib.nullcontext()))
        self.isolation.enter_context(patch('bridge_pool._profile_env', side_effect=lambda _: contextlib.nullcontext()))
        for name in ('_ensure_agent_imports', '_refresh_worker_profile_env', '_refresh_approval_allowlist',
                     '_install_execute_code_approval_memory_patch'):
            self.isolation.enter_context(patch('bridge_pool.' + name))
        self.isolation.enter_context(patch('bridge_pool.SessionDbHolder.get_for_profile', return_value=None))
        for name in ('gateway', 'tools', 'agent', 'run_agent'):
            module = types.ModuleType(name)
            module.__path__ = []
            self.isolation.enter_context(patch.dict(sys.modules, {name: module}))
        self.context = contextvars.ContextVar('fake-hermes-session', default={})
        self.gateway = types.ModuleType('gateway.session_context')
        def set_session_vars(**values):
            return [self.context.set(values)]
        def clear_session_vars(tokens):
            self.context.set({})
        names = {'HERMES_SESSION_ID': 'session_id', 'HERMES_UI_SESSION_ID': 'ui_session_id',
                 'HERMES_SESSION_KEY': 'session_key', 'HERMES_SESSION_PROFILE': 'profile'}
        self.gateway.set_session_vars = set_session_vars
        self.gateway.clear_session_vars = clear_session_vars
        self.gateway.get_session_env = lambda name, default='': self.context.get().get(names.get(name), default)
        self.isolation.enter_context(patch.dict(sys.modules, {'gateway.session_context': self.gateway}))

    def make_session(self, identity, run=None):
        from bridge_pool import AgentPool, AgentSession
        from bridge_context_manager import install_bili_compression_guard
        pool = AgentPool()
        agent = types.SimpleNamespace(session_id=identity, run_conversation=run or (lambda *a, **kw: {}))
        install_bili_compression_guard(agent, identity)
        session = AgentSession(session_id=identity, agent=agent, config={
            'profile': 'test-profile', 'context_manager': {
                'manager': 'bili', 'owner': 'bili', 'conversationId': identity,
                'proxyUrl': 'http://localhost:2345',
            },
        })
        pool._sessions[identity] = session
        return pool, session

    def run_session(self, pool, session, **options):
        from bridge_pool import RunRecord
        record = RunRecord(run_id='run-' + session.session_id, session_id=session.session_id)
        session.running = True
        session.current_run_id = record.run_id
        pool._run_chat(session, record, 'message', profile='test-profile', **options)
        return record

    def test_creation_restart_and_model_switch_keep_identity_and_guard(self):
        from bridge_pool import AgentPool
        owner, _, _, client = self.bili_fixture()
        owner['conversationId'] = 'stable-ui-id'
        created = []
        class FakeAgent:
            def __init__(self, **kwargs):
                self.__dict__.update(kwargs)
                self.tools = []
                self.client = types.SimpleNamespace(_client=client, base_url='https://fake.invalid')
                self.compression_enabled = True
                created.append(self)
            def switch_model(self, **kwargs):
                self.model = kwargs['new_model']
                self.provider = kwargs['new_provider']
                self.api_key = kwargs['api_key']
                self.base_url = kwargs['base_url']
                self.api_mode = kwargs['api_mode']
                self.compression_enabled = True
                self.codex_responses_native_compaction = True
            def run_conversation(self, message, **kwargs):
                self_id = self.session_id
                if kwargs['task_id'] != self_id:
                    raise AssertionError('foreign model task identity')
                return {}
        runtime = {'provider': 'custom', 'base_url': 'https://fake.invalid',
                   'api_key': 'fake-key', 'api_mode': 'chat_completions'}
        with patch.object(sys.modules['run_agent'], 'AIAgent', FakeAgent, create=True), \
             patch('bridge_context_manager.discover_context_owner', return_value=owner), \
             patch('bridge_pool._discover_bridge_mcp_tools', return_value=[]), \
             patch('bridge_pool._load_cfg', return_value={}), \
             patch('bridge_pool._resolve_runtime', return_value=runtime), \
             patch('bridge_pool._load_reasoning_config', return_value=None), \
             patch('bridge_pool._load_service_tier', return_value=None), \
             patch('bridge_pool._load_enabled_toolsets', return_value=[]):
            for _ in range(2):
                pool = AgentPool()
                session = pool.get_or_create('stable-ui-id', profile='test-profile', model='model-a', provider='custom')
                self.assertIs(pool.get_or_create('stable-ui-id', profile='test-profile', model='model-a', provider='custom'), session)
                self.assertEqual(session.config['profile'], 'test-profile')
                self.assertEqual(session.agent.model, 'model-a')
                self.assertIsNone(session.agent.session_db)
                self.assertEqual(session.agent.session_id, 'stable-ui-id')
                self.assertEqual(self.run_session(pool, session).status, 'complete')
                result = pool._switch_loaded_session_model(session, 'model-b', 'custom', 'test-profile', add_note=False)
                self.assertTrue(result['switched'])
                self.assertEqual(session.agent.model, 'model-b')
                self.assertEqual(session.agent.session_id, 'stable-ui-id')
                self.assertFalse(session.agent.compression_enabled)
                self.assertFalse(session.agent.codex_responses_native_compaction)
                with self.assertRaisesRegex(RuntimeError, 'bili owns'):
                    session.agent._compress_context([], 'system')
                self.assertEqual(self.run_session(pool, session).status, 'complete')
                self.assertEqual(self.context.get(), {})
        self.assertEqual(len(created), 2)

    def test_bili_context_binding_failure_stops_before_model(self):
        from unittest.mock import Mock
        model = Mock()
        pool, session = self.make_session('studio-session', model)
        with patch('bridge_pool._set_bridge_session_vars', side_effect=RuntimeError('context unavailable')):
            record = self.run_session(pool, session)
        self.assertEqual(record.status, 'error')
        self.assertIn('context', record.error)
        model.assert_not_called()

    def test_bili_foreign_context_stops_before_model_and_clears(self):
        from unittest.mock import Mock
        model = Mock()
        pool, session = self.make_session('studio-session', model)
        self.gateway.get_session_env = lambda name, default='': 'foreign-session'
        record = self.run_session(pool, session)
        self.assertEqual(record.status, 'error')
        self.assertIn('identity', record.error)
        model.assert_not_called()
        self.assertEqual(self.context.get(), {})

    def test_bili_legacy_context_without_session_id_fails_closed(self):
        def legacy_set_session_vars(platform='', session_key=''):
            return [self.context.set({'platform': platform, 'session_key': session_key})]
        self.gateway.set_session_vars = legacy_set_session_vars
        pool, session = self.make_session('studio-session')
        record = self.run_session(pool, session)
        self.assertEqual(record.status, 'error')
        self.assertIn('identity', record.error)
        self.assertEqual(self.context.get(), {})

    def test_bili_legacy_context_cannot_use_matching_environment(self):
        def legacy_set_session_vars(platform='', session_key=''):
            return [self.context.set({'platform': platform, 'session_key': session_key})]
        self.gateway.set_session_vars = legacy_set_session_vars
        self.gateway.get_session_env = lambda name, default='': os.environ.get(name, default)
        pool, session = self.make_session('studio-session')
        with patch.dict(os.environ, {'HERMES_SESSION_ID': 'studio-session', 'HERMES_UI_SESSION_ID': 'studio-session'}):
            record = self.run_session(pool, session)
        self.assertEqual(record.status, 'error')
        self.assertIn('identity', record.error)
        self.assertEqual(self.context.get(), {})

    def test_native_binding_failure_keeps_legacy_runtime_compatibility(self):
        pool, session = self.make_session('native-session')
        session.config['context_manager'] = {'manager': 'native'}
        with patch('bridge_pool._set_bridge_session_vars', side_effect=ImportError('old Hermes')):
            record = self.run_session(pool, session)
        self.assertEqual(record.status, 'complete')

    def test_parallel_models_and_tools_keep_task_local_identity(self):
        barrier = threading.Barrier(2)
        observed = []
        records = []
        def run(identity):
            def model(message, **kwargs):
                barrier.wait(5)
                values = self.context.get()
                self.assertEqual(values['session_id'], identity)
                self.assertEqual(values['ui_session_id'], identity)
                self.assertEqual(kwargs['task_id'], identity)
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
                    futures = [executor.submit(contextvars.copy_context().run, self.context.get) for _ in range(2)]
                    for future in futures:
                        self.assertEqual(future.result(5)['session_id'], identity)
                observed.append(identity)
                return {}
            pool, session = self.make_session(identity, model)
            records.append(self.run_session(pool, session))
            self.assertEqual(self.context.get(), {})
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(run, identity) for identity in ('session-a', 'session-b')]
            for future in futures:
                future.result(10)
        self.assertCountEqual(observed, ['session-a', 'session-b'])
        self.assertEqual([record.status for record in records], ['complete', 'complete'])
        self.assertEqual(self.context.get(), {})

    def test_automatic_manual_and_overflow_do_not_native_compress(self):
        from unittest.mock import Mock
        for mode in ('automatic', 'manual', 'overflow'):
            with self.subTest(mode=mode):
                def model(message, **kwargs):
                    self.assertEqual(self.context.get()['session_id'], 'studio-session')
                    if mode == 'overflow':
                        raise RuntimeError('context window exceeded')
                    return {'messages': kwargs['conversation_history']}
                pool, session = self.make_session('studio-session', model)
                history = [{'role': 'user', 'content': 'uncompressed'}]
                native = Mock(side_effect=AssertionError('native double compression'))
                session.agent._compress_context = native
                with patch('bridge_context_manager.compact_session', return_value={'conversationId': session.session_id}) as compact:
                    record = self.run_session(pool, session, force_compress=mode == 'manual', conversation_history=history)
                self.assertEqual(record.status, 'error' if mode == 'overflow' else 'complete')
                self.assertEqual(compact.call_count, 1 if mode == 'manual' else 0)
                native.assert_not_called()
                self.assertEqual(history, [{'role': 'user', 'content': 'uncompressed'}])
                self.assertEqual(session.agent.session_id, 'studio-session')
                self.assertEqual(self.context.get(), {})

    def test_worker_refresh_and_restart_keep_request_override_without_config_io(self):
        from bridge_context_manager import worker_environment
        from bridge_runtime import _set_worker_profile_env, _refresh_worker_profile_env
        config = {'manager': 'bili', 'proxyUrl': 'http://localhost:2345', 'allowNativeFallback': False}
        inherited = {'BILLION_CONTEXT_ATTACH': 'http://old:1', 'BILI_NATIVE_HERMES': '0'}
        launch = worker_environment(inherited, config)
        def dotenv(profile):
            os.environ.update(inherited)
            os.environ['HERMES_STUDIO_CONTEXT_MANAGER'] = json.dumps({'manager': 'native'})
        with patch('bridge_runtime._profile_home', return_value=Path('/fake-hermes-profile')), \
             patch('bridge_runtime._apply_profile_dotenv', side_effect=dotenv), \
             patch('bridge_runtime._read_dotenv', return_value=inherited), \
             patch('bridge_runtime._refresh_terminal_env'), \
             patch('bridge_runtime._load_cfg', side_effect=AssertionError('unexpected config read')):
            for _ in range(2):
                os.environ.clear()
                os.environ.update(launch)
                _set_worker_profile_env('test-profile')
                _refresh_worker_profile_env()
                self.assertEqual(os.environ['BILLION_CONTEXT_ATTACH'], config['proxyUrl'])
                self.assertEqual(os.environ['BILI_NATIVE_HERMES'], '1')
                self.assertEqual(json.loads(os.environ['HERMES_STUDIO_CONTEXT_MANAGER']), config)
        self.assertEqual(inherited['BILI_NATIVE_HERMES'], '0')

    def test_bili_worker_env_is_local_and_explicit(self):
        from bridge_context_manager import worker_environment
        inherited = {'BILI_NATIVE_HERMES': '0', 'BILLION_CONTEXT_ATTACH': 'http://old:1', 'OTHER': 'keep'}
        env = worker_environment(inherited, {'manager': 'bili', 'proxyUrl': 'http://localhost:2345', 'allowNativeFallback': False})
        self.assertEqual(inherited['BILI_NATIVE_HERMES'], '0')
        self.assertEqual(env['BILLION_CONTEXT_ATTACH'], 'http://localhost:2345')
        self.assertEqual(env['BILI_NATIVE_HERMES'], '1')
        self.assertEqual(env['BILLION_CONTEXT_PLUGIN'], '1')
        self.assertEqual(env['OTHER'], 'keep')

    def bili_fixture(self):
        import httpx
        names = ['compress', 'decompress', 'search_context', 'acp_status', 'acp_cache']
        schema = {'type': 'object', 'properties': {}}
        manifest = {'ok': True, 'protocolVersion': 1,
                    'headers': {'conversation': 'x-bili-plugin-conversation'}, 'toolNames': names,
                    'tools': {'anthropic': [{'name': name, 'input_schema': schema} for name in names]}}
        entries = {name: types.SimpleNamespace(toolset='billion-context', schema=schema, handler=lambda args: '{}') for name in names}
        registry = types.ModuleType('tools.registry')
        registry.registry = types.SimpleNamespace(get_entry=entries.get)
        self.isolation.enter_context(patch.dict(sys.modules, {'tools.registry': registry}))
        client = httpx.Client(transport=httpx.HTTPTransport(proxy=httpx.Proxy('http://localhost:2345')), trust_env=False)
        self.addCleanup(client.close)
        owner = {'manager': 'bili', 'owner': 'bili', 'proxyUrl': 'http://localhost:2345', 'conversationId': 'parent'}
        self.isolation.enter_context(patch('bridge_context_manager.public_request', return_value=manifest))
        self.isolation.enter_context(patch.dict(os.environ, {'HTTPS_PROXY': owner['proxyUrl'], 'https_proxy': owner['proxyUrl']}))
        return owner, names, entries, client

    def request_agent_fixture(self):
        from bridge_context_manager import install_bili_worker_guard
        owner, _, _, client = self.bili_fixture()
        class Agent:
            def __init__(self, session_id='own', parent_session_id=None, model='model-a',
                         context_length=123456, max_tokens=2048, api_mode='chat_completions'):
                self.session_id = session_id
                self._parent_session_id = parent_session_id
                self.model, self.max_tokens, self.api_mode = model, max_tokens, api_mode
                self.provider, self.base_url = 'custom-test', 'https://provider.invalid/v1'
                self.tools = []
                self.client = self._anthropic_client = types.SimpleNamespace(
                    _client=client, base_url=self.base_url)
                self.context_compressor = types.SimpleNamespace(
                    model=model, provider=self.provider, base_url=self.base_url,
                    api_mode=api_mode, context_length=context_length)
            def _interruptible_api_call(self, api_kwargs):
                return api_kwargs
            def _interruptible_streaming_api_call(self, api_kwargs, *, on_first_delta=None):
                return api_kwargs
            def switch_model(self, model, context_length, max_tokens):
                self.model, self.max_tokens = model, max_tokens
                self.context_compressor.model = model
                self.context_compressor.context_length = context_length
        install_bili_worker_guard(Agent, owner)
        return Agent

    def test_first_request_headers_use_current_compressor_and_wire_output(self):
        Agent = self.request_agent_fixture()
        for mode in ('chat_completions', 'anthropic', 'anthropic_messages'):
            for method in ('_interruptible_api_call', '_interruptible_streaming_api_call'):
                for output_key in ('max_completion_tokens', 'max_tokens', 'max_output_tokens'):
                    with self.subTest(mode=mode, method=method, output_key=output_key):
                        agent = Agent(api_mode=mode)
                        headers = {'authorization': 'keep', 'anthropic-beta': 'keep-beta',
                                   'x-bili-plugin-conversation': 'own', 'x-bili-plugin': 'hermes',
                                   'X-Bili-Plugin-Context-Window': '999999',
                                   'X-Bili-Plugin-Model': 'old-model', 'x-bili-plugin-max-output': '9999'}
                        kwargs = {'model': agent.model, output_key: 321, 'extra_headers': headers}
                        actual = getattr(agent, method)(api_kwargs=kwargs)['extra_headers']
                        self.assertEqual(actual['x-bili-plugin-context-window'], '123456')
                        self.assertEqual(actual['x-bili-plugin-model'], 'model-a')
                        self.assertEqual(actual['x-bili-plugin-max-output'], '321')
                        self.assertEqual(actual['authorization'], 'keep')
                        self.assertEqual(actual['anthropic-beta'], 'keep-beta')
                        self.assertEqual(actual['x-bili-plugin-conversation'], 'own')
                        self.assertEqual(actual['x-bili-plugin'], 'hermes')
                        self.assertNotIn('X-Bili-Plugin-Context-Window', actual)
                        self.assertEqual(headers['X-Bili-Plugin-Context-Window'], '999999')
                        self.assertIs(kwargs['extra_headers'], headers)

    def test_request_headers_refresh_model_switch_and_isolate_agents(self):
        Agent = self.request_agent_fixture()
        parent = Agent(session_id='parent', context_length=123456)
        child = Agent(session_id='child', parent_session_id='parent', model='model-b',
                      context_length=234567, max_tokens=512)
        other_profile = Agent(session_id='other-profile', context_length=456789, max_tokens=1024)
        barrier = threading.Barrier(3)
        def request(agent):
            barrier.wait(5)
            return agent._interruptible_api_call({'model': agent.model})['extra_headers']
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
            futures = [executor.submit(request, agent) for agent in (parent, child, other_profile)]
            actual = [future.result(10) for future in futures]
        self.assertEqual([item['x-bili-plugin-context-window'] for item in actual],
                         ['123456', '234567', '456789'])
        self.assertEqual([item['x-bili-plugin-max-output'] for item in actual], ['2048', '512', '1024'])
        parent.switch_model('model-c', 345678, 4096)
        switched = parent._interruptible_streaming_api_call({'model': 'model-c'})['extra_headers']
        self.assertEqual(switched['x-bili-plugin-model'], 'model-c')
        self.assertEqual(switched['x-bili-plugin-context-window'], '345678')
        self.assertEqual(switched['x-bili-plugin-max-output'], '4096')
        self.assertEqual(child._interruptible_api_call({'model': 'model-b'})['extra_headers'], actual[1])

    def test_request_headers_do_not_invent_invalid_or_stale_windows(self):
        Agent = self.request_agent_fixture()
        for value in (None, 0, -1, True, 123.5, '123456', float('nan'), float('inf')):
            with self.subTest(window=value):
                agent = Agent(context_length=value)
                kwargs = {'model': 'model-a', 'extra_headers': {'x-bili-plugin-context-window': 'stale'}}
                self.assertNotIn('x-bili-plugin-context-window', agent._interruptible_api_call(kwargs)['extra_headers'])
        for field, value in (('model', 'old'), ('provider', 'old'), ('base_url', 'https://other.invalid'),
                             ('api_mode', 'anthropic')):
            with self.subTest(stale_field=field):
                agent = Agent()
                setattr(agent.context_compressor, field, value)
                self.assertNotIn('x-bili-plugin-context-window',
                                 agent._interruptible_api_call({'model': 'model-a'})['extra_headers'])
        agent = Agent()
        self.assertNotIn('x-bili-plugin-context-window',
                         agent._interruptible_api_call({'model': 'auxiliary-model'})['extra_headers'])
        agent.context_compressor = None
        self.assertNotIn('x-bili-plugin-context-window',
                         agent._interruptible_api_call({'model': 'model-a'})['extra_headers'])

    def test_request_headers_do_not_reuse_stale_output_or_patch_native_agents(self):
        Agent = self.request_agent_fixture()
        for value in (None, 0, -1, True, '321', 12.5):
            with self.subTest(output=value):
                agent = Agent()
                kwargs = {'model': 'model-a', 'max_tokens': value,
                          'extra_headers': {'x-bili-plugin-max-output': 'stale'}}
                self.assertNotIn('x-bili-plugin-max-output', agent._interruptible_api_call(kwargs)['extra_headers'])
        from bridge_context_manager import install_bili_worker_guard
        class Native:
            def _interruptible_api_call(self, api_kwargs):
                return api_kwargs
        original = Native._interruptible_api_call
        install_bili_worker_guard(Native, {'manager': 'native'})
        self.assertIs(Native._interruptible_api_call, original)
        self.assertEqual(Native()._interruptible_api_call({'model': 'model-a'}), {'model': 'model-a'})

    def test_worker_guard_covers_future_delegated_construction_and_final_tools(self):
        from bridge_context_manager import install_bili_worker_guard
        owner, names, entries, client = self.bili_fixture()
        calls = []
        class Agent:
            def __init__(self, session_id=None, parent_session_id=None, enabled_toolsets=None):
                self.session_id = session_id or 'child-own-id'
                self._parent_session_id = parent_session_id
                self.enabled_toolsets = enabled_toolsets
                self.compression_enabled = True
                self.context_compressor = types.SimpleNamespace(_micro_compact_enabled=True)
                self.api_mode = 'chat_completions'
                self.client = types.SimpleNamespace(_client=client, base_url='https://provider.invalid/v1')
                self.tools = [{'type': 'function', 'function': {'name': 'terminal', 'parameters': {}}}]
                self.valid_tool_names = {'terminal'}
            def run_conversation(self, message, task_id=None):
                calls.append((self.session_id, task_id, self.compression_enabled))
                return self.session_id
            def switch_model(self):
                self.compression_enabled = True
                self.tools = []
        install_bili_worker_guard(Agent, owner)
        install_bili_worker_guard(Agent, owner)
        parent = Agent(session_id='parent', enabled_toolsets=['terminal'])
        child = Agent(parent_session_id=parent.session_id, enabled_toolsets=['terminal'])
        self.assertNotEqual(child.session_id, parent.session_id)
        self.assertFalse(child.compression_enabled)
        self.assertFalse(child.context_compressor._micro_compact_enabled)
        self.assertEqual({t['function']['name'] for t in child.tools}, set(names) | {'terminal'})
        self.assertEqual(child.valid_tool_names, set(names) | {'terminal'})
        for tool in child.tools[1:]:
            self.assertEqual(tool['function']['parameters'], entries[tool['function']['name']].schema)
        child.compression_enabled = True  # Delegation applies settings after construction.
        self.assertEqual(child.run_conversation('message', task_id='sa-task'), 'child-own-id')
        self.assertEqual(calls, [('child-own-id', 'sa-task', False)])
        child.switch_model()
        self.assertFalse(child.compression_enabled)
        self.assertEqual(child.valid_tool_names, set(names))
        with self.assertRaisesRegex(RuntimeError, 'bili owns'):
            child._compress_context([], 'system')
        with self.assertRaisesRegex(RuntimeError, 'identity'):
            Agent(session_id='parent', parent_session_id='parent')

    def test_final_tools_reject_conflicting_registry_and_agent_schemas(self):
        from bridge_context_manager import ensure_bili_agent
        owner, names, entries, client = self.bili_fixture()
        agent = types.SimpleNamespace(session_id='own', api_mode='chat_completions', tools=[],
                                      client=types.SimpleNamespace(_client=client, base_url='https://provider.invalid'))
        entries[names[0]].toolset = 'foreign'
        with self.assertRaisesRegex(RuntimeError, 'tool.*conflict'):
            ensure_bili_agent(agent, owner)
        entries[names[0]].toolset = 'billion-context'
        agent.tools = [{'type': 'function', 'function': {'name': names[0], 'parameters': {'foreign': True}}}]
        with self.assertRaisesRegex(RuntimeError, 'tool.*conflict'):
            ensure_bili_agent(agent, owner)

    def test_actual_client_transport_rejects_bypass_and_wrong_proxy(self):
        import httpx
        from bridge_context_manager import verify_bili_transport
        owner, _, _, _ = self.bili_fixture()
        for options in ({'trust_env': False}, {'transport': httpx.HTTPTransport(proxy=httpx.Proxy('http://foreign:9999')), 'trust_env': False},
                        {'trust_env': True}):
            with self.subTest(options=options), patch.dict(os.environ, {'NO_PROXY': 'provider.invalid'}), httpx.Client(**options) as client:
                agent = types.SimpleNamespace(api_mode='chat_completions',
                    client=types.SimpleNamespace(_client=client, base_url='https://provider.invalid'))
                with self.assertRaisesRegex(RuntimeError, 'transport|proxy'):
                    verify_bili_transport(agent, owner)
        with self.assertRaisesRegex(RuntimeError, 'transport'):
            verify_bili_transport(types.SimpleNamespace(api_mode='acp'), owner)

    def test_real_hermes_responses_verifies_the_request_client(self):
        if not (REAL_HERMES_ROOT / 'run_agent.py').is_file():
            self.skipTest('real Hermes runtime unavailable; set HERMES_AGENT_ROOT')
        script = r'''
import contextlib
import json
import os
import socketserver
import ssl
import subprocess
import threading
import types
from pathlib import Path
from unittest.mock import patch
import certifi
import httpx
from openai import OpenAI
from run_agent import AIAgent
from agent.transports.codex import ResponsesApiTransport
from bridge_context_manager import install_bili_worker_guard, verify_bili_transport

home = Path(os.environ['HERMES_HOME'])
bundle, key = home / 'test-ca.pem', home / 'test-key.pem'
subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                '-subj', '/CN=provider.invalid', '-addext', 'basicConstraints=critical,CA:TRUE',
                '-addext', 'subjectAltName=DNS:provider.invalid', '-days', '1',
                '-keyout', str(key), '-out', str(bundle)],
               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
server_tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
server_tls.load_cert_chain(str(bundle), str(key))
wire = []
class Proxy(socketserver.StreamRequestHandler):
    def handle(self):
        connect = self.rfile.readline().decode().strip()
        while self.rfile.readline() not in (b'\r\n', b''):
            pass
        self.wfile.write(b'HTTP/1.1 200 Connection Established\r\n\r\n')
        self.wfile.flush()
        with server_tls.wrap_socket(self.connection, server_side=True) as tls:
            stream = tls.makefile('rb')
            request = stream.readline().decode().strip()
            headers = {}
            while True:
                line = stream.readline()
                if line in (b'\r\n', b''):
                    break
                name, value = line.decode().split(':', 1)
                headers[name.lower()] = value.strip()
            body = json.loads(stream.read(int(headers['content-length'])))
            wire.append((connect, request, body, headers))
            response = {'id': 'local-fixture', 'object': 'response', 'created_at': 1,
                        'status': 'completed', 'model': 'test-model',
                        'output': [{'id': 'msg-fixture', 'type': 'message', 'role': 'assistant',
                                    'status': 'completed', 'content': [{'type': 'output_text',
                                    'text': 'local verified', 'annotations': []}]}]}
            item = {'type': 'response.output_item.done', 'output_index': 0, 'item': response['output'][0]}
            event = {'type': 'response.completed', 'response': response}
            data = ('event: response.output_item.done\ndata: ' + json.dumps(item) + '\n\n' +
                    'event: response.completed\ndata: ' + json.dumps(event) + '\n\n').encode()
            tls.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n' +
                        ('Content-Length: ' + str(len(data)) + '\r\n\r\n').encode() + data)
proxy = socketserver.ThreadingTCPServer(('127.0.0.1', 0), Proxy)
thread = threading.Thread(target=proxy.serve_forever, daemon=True)
thread.start()
owner = {'manager': 'bili', 'proxyUrl': 'http://127.0.0.1:' + str(proxy.server_address[1]),
         'caBundlePath': str(bundle)}
manifest = json.loads(os.environ.pop('TEST_BILI_MANIFEST'))
os.environ['HTTPS_PROXY'] = os.environ['https_proxy'] = owner['proxyUrl']

class Agent(AIAgent):
    # Keep real transport selection and Responses dispatch, without init/plugin IO.
    def __init__(self, sdk, session_id='child', parent_session_id='parent',
                 model='test-model', context_length=123456, max_tokens=2048):
        self.client = sdk
        self.api_mode = 'codex_responses'
        self.provider = 'custom-test'
        self.model = model
        self.base_url = str(sdk.base_url)
        self.max_tokens = max_tokens
        self.context_compressor = types.SimpleNamespace(model=model, provider=self.provider,
            base_url=self.base_url, api_mode=self.api_mode, context_length=context_length)
        self.session_id = session_id
        self._parent_session_id = parent_session_id
        self.tools = []
        self._interrupt_requested = False
    def switch_model(self, model=None, context_length=None, max_tokens=None):
        if model is not None:
            self.model = self.context_compressor.model = model
            self.context_compressor.context_length = context_length
            self.max_tokens = max_tokens
        self.compression_enabled = True
        self.codex_responses_native_compaction = True

with contextlib.ExitStack() as stack:
    stack.callback(proxy.server_close)
    stack.callback(thread.join, 5)
    stack.callback(proxy.shutdown)
    trusted = ssl.create_default_context(cafile=str(bundle))
    def sdk(**options):
        http = stack.enter_context(httpx.Client(**options))
        return stack.enter_context(OpenAI(api_key='test-only', base_url='https://provider.invalid/v1',
                                         http_client=http, max_retries=0))
    good = sdk(transport=httpx.HTTPTransport(proxy=owner['proxyUrl'], verify=trusted), trust_env=False)
    request_sdk = sdk(transport=httpx.HTTPTransport(proxy=owner['proxyUrl'], verify=trusted), trust_env=False)
    assert request_sdk is not good
    real_create = request_sdk.responses.create
    from tools.registry import registry
    schema = {'type': 'object'}
    entries = {name: types.SimpleNamespace(toolset='billion-context', schema=schema, handler=lambda args: '{}')
               for name in manifest['toolNames']}
    stack.enter_context(patch.object(registry, 'get_entry', side_effect=entries.get))
    stack.enter_context(patch('bridge_context_manager.public_request', return_value=manifest))
    install_bili_worker_guard(Agent, owner)
    agent = Agent(good)
    assert isinstance(agent._get_transport(), ResponsesApiTransport)
    verify_bili_transport(agent, owner)
    assert agent._bridge_bili_conversation_id == 'child'
    assert not agent.compression_enabled and not agent.codex_responses_native_compaction
    agent.switch_model()
    assert not agent.compression_enabled and not agent.codex_responses_native_compaction

    class Sent(BaseException):
        pass
    attempted = []
    def sent(**kwargs):
        attempted.append(kwargs)
        raise Sent()
    # Execute the real Hermes forwarder + codex_runtime through responses.create.
    stack.enter_context(patch.object(good.responses, 'create', side_effect=sent))
    stack.enter_context(patch.object(request_sdk.responses, 'create', side_effect=sent))
    def request(client=None, positional=False):
        kwargs = {'model': 'test-model', 'input': []}
        try:
            if positional:
                agent._run_codex_stream(kwargs, client)
            else:
                agent._run_codex_stream(kwargs, client=client)
        except Sent:
            return
        raise AssertionError('Responses dispatch did not reach the verified SDK')
    request(request_sdk)
    request(request_sdk, positional=True)
    # Pin the exact fallback client before the upstream primary-client resolver can run again.
    with patch.object(agent, '_ensure_primary_openai_client', return_value=good) as resolve:
        request()
        assert resolve.call_count == 1
    assert len(attempted) == 3 and all(item['stream'] for item in attempted)

    rejected = [sdk(trust_env=False),
                sdk(transport=httpx.HTTPTransport(proxy='http://foreign:9999'), trust_env=False),
                sdk(transport=httpx.HTTPTransport(proxy=owner['proxyUrl'], verify=False), trust_env=False),
                sdk(transport=httpx.HTTPTransport(proxy=owner['proxyUrl'],
                    verify=ssl.create_default_context(cafile=certifi.where())), trust_env=False),
                sdk(mounts={'https://provider.invalid': httpx.HTTPTransport()}, trust_env=True)]
    with patch.dict(os.environ, {'NO_PROXY': 'provider.invalid'}):
        rejected.append(sdk(trust_env=True))
    for bad in rejected:
        with patch.object(bad.responses, 'create', side_effect=AssertionError('unverified SDK was used')):
            try:
                request(bad)
            except RuntimeError as exc:
                assert any(word in str(exc) for word in ('proxy', 'TLS', 'transport', 'CA'))
            else:
                raise AssertionError('unverified request client accepted')
    assert len(attempted) == 3
    for mode in ('acp', 'codex_app_server', 'unknown'):
        agent.api_mode = mode
        try:
            verify_bili_transport(agent, owner)
        except RuntimeError:
            pass
        else:
            raise AssertionError('unverifiable mode accepted')
    agent.api_mode = 'codex_responses'
    with patch.object(agent, '_get_transport', return_value=object()):
        try:
            verify_bili_transport(agent, owner)
        except RuntimeError:
            pass
        else:
            raise AssertionError('unverifiable Responses adapter accepted')
    for name in ('_get_transport', '_run_codex_stream'):
        with patch.object(agent, name, None):
            try:
                verify_bili_transport(agent, owner)
            except RuntimeError:
                pass
            else:
                raise AssertionError('unverifiable Responses dispatch accepted')
    try:
        verify_bili_transport(agent, owner, sdk=types.SimpleNamespace(
            _client=good._client, base_url=good.base_url))
    except RuntimeError:
        pass
    else:
        raise AssertionError('non-OpenAI SDK transport accepted')
    for identity in ('parent', 'rotated'):
        agent.session_id = identity
        try:
            request(good)
        except RuntimeError as exc:
            assert 'identity' in str(exc)
        else:
            raise AssertionError('unstable or parent identity accepted')
    assert len(attempted) == 3
    agent.session_id = 'child'
    with patch.object(request_sdk.responses, 'create', side_effect=real_create), \
         patch.object(agent, '_touch_activity'), patch.object(agent, '_fire_reasoning_delta'), \
         patch.object(agent, '_fire_stream_delta'):
        kwargs = {'model': 'test-model', 'input': [], 'max_output_tokens': 321,
                  'extra_headers': {'x-bili-plugin-conversation': 'child', 'x-existing': 'keep',
                                    'x-bili-plugin-max-output': '9999'}}
        result = agent._run_codex_stream(kwargs, client=request_sdk)
        assert kwargs['extra_headers']['x-bili-plugin-max-output'] == '9999'
    assert result.status == 'completed' and result.output[0].content[0].text == 'local verified'
    assert len(wire) == 1
    assert wire[0][0] == 'CONNECT provider.invalid:443 HTTP/1.1'
    assert wire[0][1] == 'POST /v1/responses HTTP/1.1'
    assert wire[0][2]['stream'] is True
    assert wire[0][3]['x-bili-plugin-context-window'] == '123456'
    assert wire[0][3]['x-bili-plugin-model'] == wire[0][2]['model'] == 'test-model'
    assert wire[0][3]['x-bili-plugin-max-output'] == '321'
    assert wire[0][3]['x-existing'] == 'keep'
    assert 'x-bili-plugin-context-window' not in request_sdk.default_headers
    agent.switch_model('switched-model', 234567, 512)
    child = Agent(good, session_id='delegated-child', parent_session_id='child',
                  model='child-model', context_length=345678, max_tokens=1024)
    for current in (agent, child, agent):
        with patch.object(request_sdk.responses, 'create', side_effect=real_create), \
             patch.object(current, '_touch_activity'), patch.object(current, '_fire_reasoning_delta'), \
             patch.object(current, '_fire_stream_delta'):
            current._run_codex_stream({'model': current.model, 'input': [],
                'extra_headers': {'x-bili-plugin-conversation': current.session_id}}, client=request_sdk)
    assert len(wire) == 4
    assert [item[3]['x-bili-plugin-context-window'] for item in wire] == ['123456', '234567', '345678', '234567']
    assert [item[3]['x-bili-plugin-max-output'] for item in wire] == ['321', '512', '1024', '512']
    assert [item[3]['x-bili-plugin-conversation'] for item in wire] == ['child', 'child', 'delegated-child', 'child']
    assert all(item[3]['x-bili-plugin-model'] == item[2]['model'] for item in wire)
print('real Responses dispatch: 3 guarded calls; 6 bypass/CA clients rejected; HTTPS CONNECT/SSE completed')
'''
        with tempfile.TemporaryDirectory(dir=SCRATCH_DIR) as home:
            env = {'PATH': os.defpath, 'HOME': home, 'HERMES_HOME': home,
                   'PYTHONDONTWRITEBYTECODE': '1', 'TMPDIR': SCRATCH_DIR or home,
                   'PYTHONPATH': os.pathsep.join((sys.path[0], str(REAL_HERMES_ROOT))),
                   'TEST_BILI_MANIFEST': json.dumps(public_manifest_fixture())}
            result = subprocess.run([sys.executable, '-c', script], env=env,
                                    capture_output=True, text=True, timeout=90)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('real Responses dispatch: 3 guarded calls', result.stdout)

    def test_actual_anthropic_transport_is_verified(self):
        from bridge_context_manager import verify_bili_transport
        owner, _, _, client = self.bili_fixture()
        for mode in ('anthropic', 'anthropic_messages'):
            with self.subTest(mode=mode):
                agent = types.SimpleNamespace(api_mode=mode, client=None,
                    _anthropic_client=types.SimpleNamespace(_client=client, base_url='https://api.anthropic.com'))
                verify_bili_transport(agent, owner)

    def test_actual_proxy_origin_uses_canonical_default_port(self):
        import httpx
        from bridge_context_manager import verify_bili_transport
        owner, _, _, _ = self.bili_fixture()
        owner['proxyUrl'] = 'http://localhost:80'
        with patch.dict(os.environ, {'HTTPS_PROXY': 'http://localhost', 'https_proxy': 'http://localhost'}), \
             httpx.Client(transport=httpx.HTTPTransport(proxy=httpx.Proxy('http://localhost')), trust_env=False) as client:
            agent = types.SimpleNamespace(api_mode='chat_completions',
                client=types.SimpleNamespace(_client=client, base_url='https://provider.invalid'))
            verify_bili_transport(agent, owner)

    def test_actual_transport_rejects_disabled_tls_without_ca_binding(self):
        import httpx
        from bridge_context_manager import verify_bili_transport
        owner, _, _, _ = self.bili_fixture()
        with httpx.Client(transport=httpx.HTTPTransport(proxy=httpx.Proxy(owner['proxyUrl']), verify=False), trust_env=False) as client:
            agent = types.SimpleNamespace(api_mode='chat_completions',
                client=types.SimpleNamespace(_client=client, base_url='https://provider.invalid'))
            with self.assertRaisesRegex(RuntimeError, 'TLS|CA'):
                verify_bili_transport(agent, owner)

    def test_actual_transport_must_trust_bound_profile_ca(self):
        import httpx
        from bridge_context_manager import bind_bili_ca, verify_bili_transport
        owner, _, _, _ = self.bili_fixture()
        with tempfile.TemporaryDirectory(dir=SCRATCH_DIR) as directory:
            bundle = Path(directory) / 'ca.pem'
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                '-subj', '/CN=Worker Profile CA', '-addext', 'basicConstraints=critical,CA:TRUE',
                '-days', '1', '-keyout', str(Path(directory) / 'key.pem'), '-out', str(bundle)],
                check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            owner['caBundlePath'] = str(bundle)
            trusted = ssl.create_default_context(cafile=str(bundle))
            wrong_profile = ssl.create_default_context()
            bind_bili_ca(owner)
            self.assertEqual(os.environ['HERMES_CA_BUNDLE'], str(bundle))
            for context in (trusted, wrong_profile, False):
                with self.subTest(context=context), httpx.Client(
                    transport=httpx.HTTPTransport(proxy=httpx.Proxy(owner['proxyUrl']), verify=context), trust_env=False) as client:
                    agent = types.SimpleNamespace(api_mode='chat_completions',
                        client=types.SimpleNamespace(_client=client, base_url='https://provider.invalid'))
                    if context is trusted:
                        verify_bili_transport(agent, owner)
                    else:
                        with self.assertRaisesRegex(RuntimeError, 'CA|TLS'):
                            verify_bili_transport(agent, owner)
            owner['caBundlePath'] = str(Path(directory) / 'missing.pem')
            with self.assertRaisesRegex(RuntimeError, 'missing or invalid'):
                bind_bili_ca(owner)

    def test_discovery_rejects_attached_fallback_to_different_actual_proxy(self):
        from bridge_context_manager import discover_context_owner
        self.bili_fixture()
        manager = types.SimpleNamespace(discover_and_load=lambda: None, list_plugins=lambda: [
            {'name': 'billion-context', 'enabled': True, 'middleware': 1, 'tools': 5}])
        module = types.ModuleType('hermes_cli.plugins')
        module.get_plugin_manager = lambda: manager
        with patch.dict(sys.modules, {'hermes_cli.plugins': module}), patch.dict(os.environ, {
            'HERMES_STUDIO_CONTEXT_MANAGER': json.dumps({'manager': 'bili', 'proxyUrl': 'http://localhost:2345', 'allowNativeFallback': True}),
            'HTTPS_PROXY': 'http://fallback:6789', 'https_proxy': 'http://fallback:6789'}):
            with self.assertRaisesRegex(RuntimeError, 'proxy'):
                discover_context_owner('own')

    def test_profile_ca_binding_is_explicit_and_native_environment_unchanged(self):
        from bridge_context_manager import worker_environment
        inherited = {'SSL_CERT_FILE': '/global/ca.pem', 'HERMES_CA_BUNDLE': '/global/root.pem'}
        path = '/profile-x/data/billion-context/ca/combined-ca.pem'
        env = worker_environment(inherited, {'manager': 'bili', 'proxyUrl': 'http://localhost:2345', 'caBundlePath': path})
        self.assertEqual(env['HERMES_CA_BUNDLE'], path)
        self.assertEqual(env['SSL_CERT_FILE'], path)
        self.assertEqual(json.loads(env['HERMES_STUDIO_CONTEXT_MANAGER'])['caBundlePath'], path)
        native = worker_environment(inherited, {'manager': 'native', 'caBundlePath': path})
        self.assertEqual(native['SSL_CERT_FILE'], inherited['SSL_CERT_FILE'])
        self.assertEqual(inherited['HERMES_CA_BUNDLE'], '/global/root.pem')

    def test_native_preserves_independent_plugin(self):
        from bridge_context_manager import worker_environment
        env = {'BILI_NATIVE_HERMES': '1', 'BILLION_CONTEXT_ATTACH': 'http://localhost:2345'}
        self.assertEqual(worker_environment(env, {'manager': 'native', 'allowNativeFallback': False})['BILLION_CONTEXT_ATTACH'], env['BILLION_CONTEXT_ATTACH'])

    def test_compression_guard_preserves_identity_and_history(self):
        from bridge_context_manager import install_bili_compression_guard
        agent = types.SimpleNamespace(session_id='studio-session', compression_enabled=True)
        install_bili_compression_guard(agent, 'studio-session')
        history = [{'role': 'user', 'content': 'preserve'}]
        with self.assertRaisesRegex(RuntimeError, 'bili owns'):
            agent._compress_context(history, 'system', approx_tokens=100)
        self.assertFalse(agent.compression_enabled)
        self.assertEqual(agent.session_id, 'studio-session')
        self.assertEqual(history[0]['content'], 'preserve')

    def test_manifest_requires_all_public_tools_with_object_schemas(self):
        from bridge_context_manager import validate_manifest
        names = ['compress', 'decompress', 'search_context', 'acp_status', 'acp_cache']
        def manifest(selected):
            return {'ok': True, 'protocolVersion': 1,
                    'headers': {'conversation': 'x-bili-plugin-conversation'},
                    'toolNames': selected,
                    'tools': {'anthropic': [{'name': name, 'input_schema': {'type': 'object'}} for name in selected]}}
        validate_manifest(manifest(names))
        for name in names:
            with self.subTest(missing=name), self.assertRaisesRegex(RuntimeError, 'five public tools'):
                validate_manifest(manifest([other for other in names if other != name]))
        malformed = manifest(names)
        malformed['tools']['anthropic'][0]['input_schema'] = {}
        with self.assertRaisesRegex(RuntimeError, 'tool schemas'):
            validate_manifest(malformed)

    def test_native_plugin_discovery_is_public_and_explicit(self):
        from bridge_context_manager import discover_context_owner
        manager = types.SimpleNamespace(discover_and_load=lambda: None, list_plugins=lambda: [{'name': 'billion-context', 'enabled': True, 'middleware': 1, 'tools': 5, 'error': None}])
        module = types.ModuleType('hermes_cli.plugins')
        module.get_plugin_manager = lambda: manager
        manifest = public_manifest_fixture()
        with patch.dict(sys.modules, {'hermes_cli.plugins': module}), patch.dict(os.environ, {'HERMES_STUDIO_CONTEXT_MANAGER': json.dumps({'manager': 'native'}), 'BILLION_CONTEXT_ATTACH': 'http://localhost:2345', 'HTTPS_PROXY': 'http://localhost:2345'}), patch('bridge_context_manager.public_request', return_value=manifest):
            result = discover_context_owner('studio-session')
        self.assertEqual(result['manager'], 'bili')
        self.assertEqual(result['selectedManager'], 'native')
        self.assertTrue(result['independentPlugin'])
        self.assertEqual(result['conversationId'], 'studio-session')

    def test_selected_bili_cannot_fail_open_when_plugin_inert(self):
        from bridge_context_manager import discover_context_owner
        manager = types.SimpleNamespace(discover_and_load=lambda: None, list_plugins=lambda: [{'name': 'billion-context', 'enabled': True, 'middleware': 0, 'tools': 0}])
        module = types.ModuleType('hermes_cli.plugins')
        module.get_plugin_manager = lambda: manager
        for fallback in (False, True):
            with self.subTest(fallback=fallback), patch.dict(sys.modules, {'hermes_cli.plugins': module}), patch.dict(os.environ, {'HERMES_STUDIO_CONTEXT_MANAGER': json.dumps({'manager': 'bili', 'proxyUrl': 'http://localhost:2345', 'allowNativeFallback': fallback})}):
                with self.assertRaisesRegex(RuntimeError, 'not active'):
                    discover_context_owner('studio-session')

    def test_worker_key_cannot_alias_another_profile(self):
        from bridge_broker import BridgeBroker
        broker = BridgeBroker('tcp://localhost:1')
        self.assertNotEqual(broker._normalize_worker_key('profile-a', 'shared'), broker._normalize_worker_key('profile-b', 'shared'))

    def test_worker_configuration_excludes_conversation_identity(self):
        from bridge_context_manager import normalize_context_manager
        self.assertEqual(normalize_context_manager({'manager': 'native', 'conversationId': 'a'}),
                         normalize_context_manager({'manager': 'native', 'conversationId': 'b'}))

    def test_foreign_conversation_identity_is_rejected_before_discovery(self):
        from bridge_server import BridgeServer
        server = BridgeServer('tcp://localhost:1')
        with patch.dict(os.environ, {'HERMES_STUDIO_CONTEXT_MANAGER': json.dumps({'manager': 'native'})}):
            with self.assertRaisesRegex(ValueError, 'conversation'):
                server.handle({'action': 'context_manager_status', 'session_id': 'a',
                               'context_manager': {'manager': 'native', 'conversationId': 'b'}})

    def test_status_discovers_owner_without_creating_agent(self):
        from bridge_server import BridgeServer
        server = BridgeServer('tcp://localhost:1')
        with patch('bridge_server.discover_context_owner', return_value={'owner': 'native', 'conversationId': 's'}), patch.object(server.pool, 'get_or_create', side_effect=AssertionError('model initialization')):
            result = server.handle({'action': 'context_manager_status', 'session_id': 's'})
        self.assertEqual(result['context_manager']['owner'], 'native')
        self.assertEqual(server.pool._sessions, {})

    def test_bili_status_requires_verified_agent_transport_and_final_tools(self):
        from bridge_server import BridgeServer
        owner, _, _, _ = self.bili_fixture()
        owner['conversationId'] = 's'
        server = BridgeServer('tcp://localhost:1')
        with patch('bridge_server.discover_context_owner', return_value=owner), \
             patch.object(server.pool, 'get_or_create', side_effect=RuntimeError('provider transport bypasses proxy')) as create:
            with self.assertRaisesRegex(RuntimeError, 'transport'):
                server.handle({'action': 'context_manager_status', 'session_id': 's'})
            create.assert_called_once()

    def test_bili_owner_queries_preserve_pool_argument_identity(self):
        from bridge_server import BridgeServer
        owner, _, _, _ = self.bili_fixture()
        owner['conversationId'] = 's'
        agent = object()
        calls = []

        def get_or_create(session_id, profile=None, model=None, provider=None,
                          background_delegation_enabled=None):
            actual = (session_id, profile, model, provider)
            self.assertEqual(actual, ('s', 'profile-a', 'model-a', 'custom'))
            calls.append(actual)
            return types.SimpleNamespace(agent=agent)

        for action in ('context_owner', 'context_manager_status'):
            with self.subTest(action=action):
                server = BridgeServer('tcp://localhost:1')
                with patch('bridge_server.discover_context_owner', return_value=owner), \
                     patch.object(server.pool, 'get_or_create', side_effect=get_or_create), \
                     patch('bridge_context_manager.ensure_bili_agent') as ensure:
                    result = server.handle({'action': action, 'session_id': 's',
                                            'profile': 'profile-a', 'model': 'model-a',
                                            'provider': 'custom'})
                    ensure.assert_called_once_with(agent, owner)
                self.assertEqual(result['context_manager']['conversationId'], 's')
        self.assertEqual(len(calls), 2)

    def test_cross_profile_rejected_for_all_session_entrypoints(self):
        from bridge_broker import BridgeBroker
        broker = BridgeBroker('tcp://localhost:1')
        broker._session_profile['s'] = 'profile-a'
        broker._session_worker_key['s'] = 'profile-a'
        for action in ('chat', 'context_estimate', 'context_manager_status', 'status_if_loaded'):
            with self.subTest(action=action), patch.object(broker, '_worker_for_profile', side_effect=AssertionError('worker launch')):
                with self.assertRaisesRegex(ValueError, 'profile'):
                    broker.handle({'action': action, 'session_id': 's', 'profile': 'profile-b'})

    def test_configured_worker_routes_followups_and_separates_settings(self):
        from bridge_broker import BridgeBroker
        broker = BridgeBroker('tcp://localhost:1')
        calls = []
        worker = types.SimpleNamespace(request=lambda req, timeout: {'session_id': req.get('session_id'), 'context_manager': {'owner': 'native'}})
        def get_worker(profile, key):
            calls.append((profile, key))
            return worker
        with patch.object(broker, '_worker_for_profile', side_effect=get_worker):
            broker.handle({'action': 'context_manager_status', 'session_id': 's', 'profile': 'p', 'context_manager': {'manager': 'native', 'conversationId': 's'}})
            broker.handle({'action': 'chat', 'session_id': 's', 'profile': 'p'})
            broker.handle({'action': 'context_manager_status', 'session_id': 's', 'profile': 'p', 'context_manager': {'manager': 'bili', 'proxyUrl': 'http://localhost:2345', 'conversationId': 's'}})
        self.assertEqual(calls[0], calls[1])
        self.assertNotEqual(calls[0], calls[2])
        self.assertIn(':context:', calls[0][1])

    def test_missing_profile_never_falls_back_to_default(self):
        from bridge_runtime import _profile_home
        with patch('bridge_runtime._base_hermes_home', return_value=Path('/nonexistent-hermes-base')):
            self.assertEqual(_profile_home('missing'), Path('/nonexistent-hermes-base/profiles/missing'))
            with self.assertRaises(ValueError):
                _profile_home('../default')

    def test_guard_disables_provider_and_micro_compaction(self):
        from bridge_context_manager import install_bili_compression_guard
        compressor = types.SimpleNamespace(_micro_compact_enabled=True)
        agent = types.SimpleNamespace(session_id='s', context_compressor=compressor,
                                      codex_responses_native_compaction=True, codex_app_server_auto_compaction=True)
        install_bili_compression_guard(agent, 's')
        self.assertFalse(agent.codex_responses_native_compaction)
        self.assertFalse(agent.codex_app_server_auto_compaction)
        self.assertFalse(compressor._micro_compact_enabled)

    def test_manual_compaction_uses_only_public_tool_and_exact_identity(self):
        from bridge_context_manager import compact_session
        owner = {'manager': 'bili', 'owner': 'bili', 'conversationId': 's', 'proxyUrl': 'http://localhost:2345'}
        manifest = public_manifest_fixture()
        manifest['tools']['anthropic'][0]['input_schema']['required'] = ['content']
        # A content-rewrite tool is not a compact operation. Never invent a
        # summary or call the host-rewrite notification endpoint.
        with patch('bridge_context_manager.public_request', return_value=manifest) as request:
            with self.assertRaisesRegex(RuntimeError, 'public.*tool'):
                compact_session(owner, 's')
        self.assertEqual(request.call_count, 1)

    def test_session_route_rejects_cross_profile(self):
        from bridge_broker import BridgeBroker
        broker = BridgeBroker('tcp://localhost:1')
        broker._session_profile['studio-session'] = 'profile-a'
        broker._session_worker_key['studio-session'] = 'profile-a'
        with self.assertRaisesRegex(ValueError, 'profile'):
            broker._route_for_session('studio-session', 'profile-b')

    def test_explicit_fallback_policy_is_preserved_not_silently_disabled(self):
        from bridge_context_manager import normalize_context_manager, discover_context_owner
        config = {'manager': 'native', 'allowNativeFallback': True}
        self.assertTrue(normalize_context_manager(config)['allowNativeFallback'])
        module = types.ModuleType('hermes_cli.plugins')
        module.get_plugin_manager = lambda: types.SimpleNamespace(discover_and_load=lambda: None, list_plugins=lambda: [])
        with patch.dict(sys.modules, {'hermes_cli.plugins': module}), patch.dict(os.environ, {'HERMES_STUDIO_CONTEXT_MANAGER': json.dumps(config)}):
            self.assertTrue(discover_context_owner('s')['allowNativeFallback'])

    def test_old_run_response_cannot_undo_session_configuration_switch(self):
        from bridge_broker import BridgeBroker
        broker = BridgeBroker('tcp://localhost:1')
        calls = []
        def get_worker(profile, key):
            calls.append(key)
            return types.SimpleNamespace(request=lambda req, timeout: {'session_id': 's', 'run_id': 'old', 'status': 'complete'} if req['action'] == 'get_output' else {'session_id': 's'})
        with patch.object(broker, '_worker_for_profile', side_effect=get_worker):
            broker.handle({'action': 'context_manager_status', 'session_id': 's', 'profile': 'p', 'context_manager': {'manager': 'native'}})
            old_key = calls[-1]
            broker._run_profile['old'] = 'p'
            broker._run_worker_key['old'] = old_key
            broker.handle({'action': 'context_manager_status', 'session_id': 's', 'profile': 'p', 'context_manager': {'manager': 'bili', 'proxyUrl': 'http://localhost:2345'}})
            new_key = calls[-1]
            broker.handle({'action': 'get_output', 'run_id': 'old'})
            self.assertEqual(calls[-1], old_key)
            self.assertEqual(broker._session_worker_key['s'], new_key)
            broker.handle({'action': 'get_output', 'run_id': 'old', 'session_id': 's'})
            self.assertEqual(calls[-1], old_key)
            self.assertEqual(broker._session_worker_key['s'], new_key)

    def test_model_switch_reinstalls_all_bili_guards(self):
        from bridge_pool import AgentPool, AgentSession
        agent = types.SimpleNamespace(session_id='s', model='old', provider='custom')
        def switch_model(**kwargs):
            agent.context_compressor = types.SimpleNamespace(_micro_compact_enabled=True)
            agent.compression_enabled = True
            agent.codex_responses_native_compaction = True
            agent.codex_app_server_auto_compaction = True
        agent.switch_model = switch_model
        session = AgentSession(session_id='s', agent=agent, config={'profile': 'default', 'model': 'old', 'context_manager': {'manager': 'bili'}})
        pool = AgentPool()
        with patch('bridge_pool._profile_env', return_value=contextlib.nullcontext()), patch('bridge_pool._refresh_worker_profile_env'), patch('bridge_pool._resolve_runtime', return_value={'provider': 'custom'}), patch('bridge_pool._load_reasoning_config', return_value={}):
            pool._switch_loaded_session_model(session, 'new', 'custom', 'default', add_note=False)
        self.assertFalse(agent.compression_enabled)
        self.assertFalse(agent.context_compressor._micro_compact_enabled)
        self.assertFalse(agent.codex_responses_native_compaction)
        self.assertFalse(agent.codex_app_server_auto_compaction)

    def test_inflight_chat_start_cannot_switch_compression_owner(self):
        import threading
        from bridge_broker import BridgeBroker
        broker = BridgeBroker('tcp://localhost:1')
        entered = threading.Event()
        release = threading.Event()
        def request(req, timeout):
            if req['action'] == 'chat':
                entered.set()
                if not release.wait(5):
                    raise RuntimeError('test release timeout')
                return {'session_id': 's', 'run_id': 'r', 'status': 'running'}
            return {'session_id': 's'}
        worker = types.SimpleNamespace(request=request)
        with patch.object(broker, '_worker_for_profile', return_value=worker):
            thread = threading.Thread(target=broker.handle, args=({'action': 'chat', 'session_id': 's', 'profile': 'p', 'context_manager': {'manager': 'native'}},))
            thread.start()
            try:
                self.assertTrue(entered.wait(5))
                with self.assertRaisesRegex(ValueError, 'running'):
                    broker.handle({'action': 'context_manager_status', 'session_id': 's', 'profile': 'p', 'context_manager': {'manager': 'bili', 'proxyUrl': 'http://localhost:2345'}})
            finally:
                release.set()
                thread.join(5)
            self.assertFalse(thread.is_alive())

    def test_public_compact_tool_round_trip_has_exact_identity(self):
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        from bridge_context_manager import compact_session
        calls = []
        identity = 'studio/session?exact'
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                calls.append(('GET', self.path))
                payload = {'ok': True, 'conversationId': identity, 'fallback': False}
                if self.path.endswith('/manifest'):
                    payload = public_manifest_fixture('compact')
                self.respond(payload)
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['content-length'])))
                calls.append(('POST', self.path, body))
                self.respond({'ok': True, 'conversationId': identity, 'result': {'ok': True}})
            def respond(self, payload):
                body = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header('content-length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            origin = 'http://127.0.0.1:' + str(server.server_port)
            result = compact_session({'manager': 'bili', 'conversationId': identity, 'proxyUrl': origin}, identity)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
        self.assertEqual(result['conversationId'], identity)
        self.assertEqual(calls, [('GET', '/__bili/plugin/manifest'), ('POST', '/__bili/plugin/tool', {'conversationId': identity, 'tool': 'compact', 'args': {}}), ('GET', '/__bili/plugin/status?conversationId=studio%2Fsession%3Fexact')])


if __name__ == '__main__':
    unittest.main()
