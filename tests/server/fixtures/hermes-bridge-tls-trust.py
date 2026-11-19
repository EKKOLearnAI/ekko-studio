"""The bridge installs Hermes' platform TLS trust before importing agent modules."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'packages/server/src/modules/hermes/services/bridge/python'))
import bridge_runtime

RECORD = 'import os\nwith open(os.environ["TLS_TRUST_EVENTS"], "a") as events:\n    events.write({event!r} + "\\n")\n'


class TlsTrustOrderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / 'hermes-agent'
        (self.root / 'agent').mkdir(parents=True)
        (self.root / 'run_agent.py').write_text('')
        (self.root / 'agent' / '__init__.py').write_text('')
        (self.root / 'agent' / 'auxiliary_client.py').write_text(RECORD.format(event='auxiliary_client') + '_OR_HEADERS_BASE = {}\n')
        self.events = Path(self.tmp.name) / 'events.txt'
        self.events.write_text('')
        env = {
            'HERMES_AGENT_ROOT': str(self.root),
            'HERMES_HOME': str(Path(self.tmp.name) / 'home'),
            'HERMES_OPENROUTER_APP_TITLE': 'Ekko Studio',
            'TLS_TRUST_EVENTS': str(self.events),
        }
        self.env = patch.dict(os.environ, env)
        self.env.start()
        os.environ.pop('HERMES_AGENT_BRIDGE_STUDIO_MCP_ENV', None)
        self.path = list(sys.path)

    def tearDown(self):
        sys.path[:] = self.path
        for name in [name for name in sys.modules if name == 'agent' or name.startswith('agent.')]:
            del sys.modules[name]
        self.env.stop()
        self.tmp.cleanup()

    def write_ssl_verify(self, body):
        (self.root / 'agent' / 'ssl_verify.py').write_text(body)

    def test_truststore_is_installed_before_agent_modules(self):
        self.write_ssl_verify('def install_truststore():\n    ' + RECORD.format(event='install_truststore').replace('\n', '\n    ') + 'return True\n')
        bridge_runtime._ensure_agent_imports()
        self.assertEqual(self.events.read_text().split(), ['install_truststore', 'auxiliary_client'])

    def test_runtime_without_ssl_verify_still_loads(self):
        bridge_runtime._ensure_agent_imports()
        self.assertEqual(self.events.read_text().split(), ['auxiliary_client'])

    def test_runtime_without_install_truststore_still_loads(self):
        self.write_ssl_verify('')
        bridge_runtime._ensure_agent_imports()
        self.assertEqual(self.events.read_text().split(), ['auxiliary_client'])

    def test_broken_ssl_verify_dependency_is_not_hidden(self):
        self.write_ssl_verify('import studio_missing_tls_dependency\n')
        with self.assertRaises(ModuleNotFoundError) as caught:
            bridge_runtime._ensure_agent_imports()
        self.assertEqual(caught.exception.name, 'studio_missing_tls_dependency')


if __name__ == '__main__':
    unittest.main()
