import { execFileSync } from 'node:child_process'
import { it } from 'vitest'

it('recalls a pending tool boundary without clearing a newer run or a reached boundary', () => {
  execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', String.raw`
import sys, types
from pathlib import Path
sys.path.insert(0, str(Path('packages/server/src/modules/hermes/services/bridge/python').resolve()))
from bridge_pool import AgentPool, AgentSession
from bridge_broker import BridgeBroker
pool = AgentPool()
cleared = []
session = AgentSession('s', types.SimpleNamespace(clear_interrupt=lambda: cleared.append(True)),
    running=True, current_run_id='r', boundary_phase='tool_batch',
    boundary_pending_run_id='r', boundary_supported=True)
pool._sessions['s'] = session
assert pool.cancel_boundary_interrupt('s', 'old')['status'] == 'run_mismatch'
assert session.boundary_pending_run_id == 'r' and not cleared
assert pool.cancel_boundary_interrupt('s', 'r')['status'] == 'cancelled'
assert session.boundary_pending_run_id is None and cleared == [True]
assert not pool._boundary_result_for_run(session, 'r')
session.boundary_pending_run_id = session.boundary_reached_run_id = 'r'
assert pool.cancel_boundary_interrupt('s', 'r')['status'] == 'too_late'
assert cleared == [True]
broker = BridgeBroker('unused')
forwarded = []
broker._forward = lambda profile, req, worker=None: forwarded.append((profile, req)) or {'status':'cancelled'}
req = {'action':'cancel_boundary_interrupt','session_id':'s','expected_run_id':'r','profile':'work'}
assert broker.handle(req)['status'] == 'cancelled'
assert forwarded[0][0] == 'work' and forwarded[0][1]['expected_run_id'] == 'r'
`], { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 })
})
