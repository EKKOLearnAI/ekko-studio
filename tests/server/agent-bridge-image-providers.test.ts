import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

function runPython(script: string): Record<string, any> {
  return JSON.parse(execFileSync('python3', ['-c', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: 'pipe',
  }))
}

describe('Agent Bridge image providers', () => {
  it('discovers provider metadata and generates through the requested provider', () => {
    const result = runPython(String.raw`
import json
import sys
import types
from pathlib import Path

bridge_dir = Path("packages/server/src/modules/hermes/services/bridge/python").resolve()
sys.path.insert(0, str(bridge_dir))
import bridge_server

class Provider:
    name = "openai"
    display_name = "OpenAI Images"
    def is_available(self): return True
    def list_models(self): return [{"id": "gpt-image-2", "display": "GPT Image 2"}]
    def default_model(self): return "gpt-image-2"
    def capabilities(self): return {"modalities": ["text", "image"], "max_reference_images": 1}
    def get_setup_schema(self):
        return {"badge": "paid", "tag": "OpenAI image generation", "env_vars": [{"key": "OPENAI_API_KEY", "prompt": "secret"}]}
    def generate(self, prompt, aspect_ratio, **kwargs):
        return {"success": True, "image": "/tmp/result.png", "model": kwargs.get("model"), "prompt": prompt, "aspect_ratio": aspect_ratio}

provider = Provider()
plugins = types.ModuleType("hermes_cli.plugins")
plugins._ensure_plugins_discovered = lambda: None
registry = types.ModuleType("agent.image_gen_registry")
registry.list_providers = lambda: [provider]
registry.get_active_provider = lambda: provider
registry.get_provider = lambda name: provider if name == "openai" else None
sys.modules["hermes_cli"] = types.ModuleType("hermes_cli")
sys.modules["hermes_cli.plugins"] = plugins
sys.modules["agent"] = types.ModuleType("agent")
sys.modules["agent.image_gen_registry"] = registry
bridge_server._ensure_agent_imports = lambda: None
server = object.__new__(bridge_server.BridgeServer)
listed = server.handle({"action": "image_providers"})
generated = server.handle({
    "action": "image_generate", "provider": "openai", "prompt": "icon",
    "aspect_ratio": "square", "model": "gpt-image-2",
})
print(json.dumps({"listed": listed, "generated": generated}))
`)

    expect(result.listed.providers[0]).toMatchObject({
      name: 'openai', display_name: 'OpenAI Images', available: true, active: true,
      default_model: 'gpt-image-2', capabilities: { modalities: ['text', 'image'] },
      setup: { required_env_vars: ['OPENAI_API_KEY'] },
    })
    expect(result.generated).toMatchObject({
      provider: 'openai',
      result: { success: true, image: '/tmp/result.png', model: 'gpt-image-2', aspect_ratio: 'square' },
    })
  })

  it('forwards list and generation payloads from the TypeScript client', async () => {
    const { AgentBridgeClient } = await import('../../packages/server/src/modules/hermes/services/bridge/client')
    const client = new AgentBridgeClient({ endpoint: 'tcp://127.0.0.1:1', connectRetryMs: 0, timeoutMs: 1 })
    const request = vi.spyOn(client, 'request').mockResolvedValue({ ok: true, providers: [] })

    await client.imageProviders('default')
    await client.imageGenerate('design', { provider: 'openai', prompt: 'icon' }, { timeoutMs: 9000 })

    expect(request).toHaveBeenNthCalledWith(1, { action: 'image_providers', profile: 'default' })
    expect(request).toHaveBeenNthCalledWith(2, {
      action: 'image_generate', profile: 'design', provider: 'openai', prompt: 'icon',
    }, { timeoutMs: 9000 })
  })
})
