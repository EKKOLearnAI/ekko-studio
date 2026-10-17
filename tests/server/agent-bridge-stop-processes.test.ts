import { execFileSync } from 'node:child_process'
import { it } from 'vitest'

it('stops only running background processes owned by the stopped session', () => {
  execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', String.raw`
import sys, types
from pathlib import Path
sys.path.insert(0, str(Path('packages/server/src/modules/hermes/services/bridge/python').resolve()))
from bridge_pool import AgentPool
queries, killed = [], []
def list_sessions(**kw):
    queries.append(kw)
    return [{'session_id':'owned','status':'running'}, {'session_id':'finished','status':'exited'}]
tools = types.ModuleType('tools')
registry = types.ModuleType('tools.process_registry')
registry.process_registry = types.SimpleNamespace(list_sessions=list_sessions, kill_process=killed.append)
sys.modules['tools'] = tools
sys.modules['tools.process_registry'] = registry
assert AgentPool()._stop_session_processes('stopped-session') == 1
assert queries == [{'session_key':'stopped-session'}]
assert killed == ['owned']
assert AgentPool().list_sessions()['running_count'] == 1
`], { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 })
})
