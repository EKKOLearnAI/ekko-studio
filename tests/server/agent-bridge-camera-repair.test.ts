import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('MCU accepts only the exact current camera from its authorized catalog', () => {
  const result = JSON.parse(execFileSync('python3', ['-c', String.raw`
import sys, json, types
from pathlib import Path
sys.path.insert(0, str(Path('packages/server/src/modules/hermes/services/bridge/python').resolve()))
from bridge_pool import AgentPool
name = 'mcp__xiaozhi_device__camera_exact_hash'
catalog = [{"type":"function", "function":{"name":name,"description":"self.camera.take_photo 实拍识图"}}]
mod = types.ModuleType('model_tools')
seen = []
def definitions(**kwargs):
    seen.append(kwargs)
    return catalog
mod.get_tool_definitions = definitions
sys.modules['model_tools'] = mod
class Agent:
    tools = []
    valid_tool_names = {'tool_call'}
    enabled_toolsets = ['mcp-xiaozhi-device']
    disabled_toolsets = ['blocked']
    def _repair_tool_call(self, name): return None
agent = Agent()
pool = AgentPool()
pool._install_mcu_camera_tool_repair(agent, 'mcu-camera')
assert agent._repair_tool_call(name) == name
assert name in agent.valid_tool_names
assert len(agent.tools) == 1
assert agent._repair_tool_call(name) == name
assert len(agent.tools) == 1
assert seen[0]['enabled_toolsets'] == ['mcp-xiaozhi-device']
assert seen[0]['disabled_toolsets'] == ['blocked']
assert agent._repair_tool_call('mcp__xiaozhi_device__stale_hash') is None
catalog.clear()
assert agent._repair_tool_call(name) is None
catalog.append({'function':{'name':name,'description':'local preview only'}})
assert agent._repair_tool_call(name) is None
other = Agent()
pool._install_mcu_camera_tool_repair(other, 'browser-chat')
assert not getattr(other._repair_tool_call, '_mcu_camera_repair', False)
print(json.dumps({'ok': True}))
`], { encoding: 'utf8' }))
  expect(result).toEqual({ ok: true })
})
