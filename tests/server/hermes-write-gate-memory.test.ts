import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { approvePendingWrite, rejectPendingWrite } from '../../packages/server/src/modules/hermes/services/write-gate/write-gate'

const python = execFileSync(process.platform === 'win32' ? 'python' : 'python3', [
  '-c', 'import sys; print(sys.executable)',
], { encoding: 'utf8' }).trim()
let directory = ''
let home = ''

function write(path: string, value: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value)
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'studio-memory-approval-'))
  home = join(directory, 'state')
  const root = join(directory, 'agent')
  vi.stubEnv('HOME', directory)
  vi.stubEnv('USERPROFILE', directory)
  vi.stubEnv('HERMES_HOME', home)
  vi.stubEnv('HERMES_AGENT_ROOT', root)
  vi.stubEnv('HERMES_AGENT_CLI_PYTHON', python)
  vi.stubEnv('HERMES_BIN', join(directory, 'missing-hermes'))
  vi.stubEnv('PYTHONPATH', '')
  vi.stubEnv('PYTHONNOUSERSITE', '1')
  write(join(root, 'tools/__init__.py'), '')
  write(join(root, 'hermes_cli/__init__.py'), '')
  write(join(root, 'tools/write_approval.py'), `
import os
from pathlib import Path
MEMORY = 'memory'
SKILLS = 'skills'
def path(subsystem, pending_id):
    return Path(os.environ['HERMES_HOME']) / 'pending' / subsystem / (pending_id + '.json')
def get_pending(subsystem, pending_id):
    return {'id': pending_id} if path(subsystem, pending_id).exists() else None
`)
  // Model only the external runtime API. Capacity/atomicity belong to Hermes.
  write(join(root, 'tools/memory_tool.py'), `
import json
import os
from pathlib import Path
class MemoryStore:
    def __init__(self, memory_char_limit=2200, user_char_limit=1375):
        self.limits = [memory_char_limit, user_char_limit]
    def load_from_disk(self):
        pass
def load_on_disk_store():
    cfg = Path(os.environ['HERMES_HOME']) / 'config.yaml'
    memory = json.loads(cfg.read_text()).get('memory', {}) if cfg.exists() else {}
    return MemoryStore(memory.get('memory_char_limit', 2200), memory.get('user_char_limit', 1375))
`)
  write(join(root, 'hermes_cli/write_approval_commands.py'), `
import json
from tools import write_approval as wa
def handle_pending_subcommand(subsystem, args, memory_store=None):
    action, pending_id = args
    if action != 'approve' or subsystem != 'memory':
        assert memory_store is None
    output = json.dumps(memory_store.limits) if memory_store else 'resolved without memory'
    wa.path(subsystem, pending_id).unlink()
    return output
`)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

function pending(profile: string, subsystem = 'memory') {
  const state = profile === 'default' ? home : join(home, 'profiles', profile)
  write(join(state, 'pending', subsystem, 'test123.json'), '{}')
  return state
}

describe('Hermes memory approval runtime store', () => {
  it('loads configured limits in the Python approval process', async () => {
    const state = pending('default')
    write(join(state, 'config.yaml'), JSON.stringify({ memory: { memory_char_limit: 4000, user_char_limit: 3000 } }))
    expect(await approvePendingWrite('default', 'memory', 'test123')).toEqual({ success: true, output: '[4000, 3000]' })
  })

  it('uses the requested profile rather than the base configuration', async () => {
    write(join(home, 'config.yaml'), JSON.stringify({ memory: { memory_char_limit: 4000, user_char_limit: 3000 } }))
    const state = pending('other')
    const config = JSON.stringify({ memory: { memory_char_limit: 3200, user_char_limit: 1800 } })
    write(join(state, 'config.yaml'), config)
    expect(await approvePendingWrite('other', 'memory', 'test123')).toEqual({ success: true, output: '[3200, 1800]' })
    expect(readFileSync(join(state, 'config.yaml'), 'utf8')).toBe(config)
  })

  it('retains runtime defaults without a configuration file', async () => {
    pending('default')
    expect(await approvePendingWrite('default', 'memory', 'test123')).toEqual({ success: true, output: '[2200, 1375]' })
  })

  it.each(['reject', 'skills'] as const)('does not load memory for %s', async (mode) => {
    const subsystem = mode === 'skills' ? 'skills' : 'memory'
    pending('default', subsystem)
    write(join(directory, 'agent/tools/memory_tool.py'), "raise RuntimeError('must not import memory')\n")
    const result = mode === 'reject'
      ? await rejectPendingWrite('default', subsystem, 'test123')
      : await approvePendingWrite('default', subsystem, 'test123')
    expect(result).toEqual({ success: true, output: 'resolved without memory' })
  })
})
