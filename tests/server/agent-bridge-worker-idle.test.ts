import { execFileSync } from 'node:child_process'
import { it } from 'vitest'

it('recycles idle polled workers without recycling active turns or background work', () => {
  execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', String.raw`
import sys, types
from pathlib import Path
sys.path.insert(0, str(Path('packages/server/src/modules/hermes/services/bridge/python').resolve()))
import bridge_transport as transport
from bridge_broker import BridgeBroker
clock = [4000]
transport.time.time = lambda: clock[0]
worker = transport.WorkerProcess('w', 'default', 'unused', None, None)
worker.process = types.SimpleNamespace(poll=lambda: None)
worker.start = lambda: None
worker.last_used_at = 0
response = {}
transport._send_bridge_request = lambda *a: response
broker = BridgeBroker('unused')
broker._last_gc = 0
broker._workers['w'] = worker
stopped = []
worker.stop = lambda: stopped.append(True)
for action in ('status', 'background_poll', 'get_result', 'get_output', 'list'):
    worker.request({'action': action})
    assert worker.last_used_at == 0
assert worker.active_requests == 0
broker._running_run_worker_key['long-turn'] = 'w'
broker._gc_idle_workers()
assert not stopped
broker._running_run_worker_key.clear()
broker._last_gc = 0
worker.active_requests = 1
broker._gc_idle_workers()
assert not stopped
worker.active_requests = 0
response = {'running_count': 1}
broker._last_gc = 0
broker._gc_idle_workers()
assert not stopped and worker.last_used_at == 4000
response = {'sessions': [{'running_count': 1}]}
worker.request({'action': 'background_poll'})
assert worker.last_used_at == 4000
broker._last_gc = 0
broker._gc_idle_workers()
assert not stopped
clock[0] += 1801
response = {'sessions': [], 'pending_count': 0}
worker.request({'action': 'background_poll'})
broker._gc_idle_workers()
assert stopped == [True] and 'w' not in broker._workers
`], { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 })
})
