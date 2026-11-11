import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const credentials = vi.hoisted(() => ({ issue: vi.fn(async () => '/test/run-auth.json'), revoke: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/services/auth/run-mcp-credentials', () => ({ runMcpCredentials: credentials }))
import { leaseEkkoMcpServers } from '../../packages/server/src/modules/studio/services/chat-run/ekko-mcp-lease'
import { studioMcpCapabilities } from '../../packages/server/src/modules/studio/public/runs/mcp-capabilities'
import { studioMcpUsageGuidelines } from '../../packages/server/src/modules/studio/public/runs/prompt'

it('binds the plugin MCP to the actual Ekko run and revokes it with the run', async () => {
  const servers = { 'ekko-studio-plugins': { command: 'node', env: { HERMES_WEB_UI_MANAGED_MCP: '1', HERMES_WEB_UI_TOKEN: 'old' } } }
  const controller = new AbortController()
  const lease = await leaseEkkoMcpServers(servers, { userId: 42, sessionId: 'session', profile: 'work', signal: controller.signal })
  expect(credentials.issue).toHaveBeenCalledWith(expect.objectContaining({ userId: 42, profile: 'work', sessionId: 'session', agentId: 'ekko-agent' }), { preserveOtherContexts: true })
  expect(lease.servers!['ekko-studio-plugins']).toMatchObject({ env: { HERMES_WEB_UI_RUN_TOKEN_FILE: '/test/run-auth.json', HERMES_WEB_UI_TOKEN: '', AUTH_TOKEN: '', HERMES_WEB_UI_PROFILE: 'work' } })
  expect(servers['ekko-studio-plugins'].env.HERMES_WEB_UI_TOKEN).toBe('old')
  controller.abort()
  expect(lease.signal.aborted).toBe(true)
  expect(credentials.revoke).toHaveBeenCalledWith('session', expect.any(String))
})

it('recognizes a plugins-only configuration without advertising API tools', () => {
  const capabilities = studioMcpCapabilities({ 'ekko-studio-plugins': { enabled: true }, 'ekko-studio-api': { enabled: false } })
  expect(capabilities).toMatchObject({ plugins: true, api: false })
  const prompt = studioMcpUsageGuidelines(capabilities)
  expect(prompt).toContain('ekko-studio-plugins')
  expect(prompt).not.toContain('ekko_studio_api_openapi_get')
  expect(studioMcpCapabilities({ 'ekko-studio-plugins': { disabled: true } }).plugins).toBe(false)
})

it('injects a separate managed service for Hermes, Ekko and supported coding agents and preserves its enable switch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-plugin-mcp-config-'))
  const script = `
    const assert = require('node:assert/strict');
    const { configureProfileConfig } = require('./packages/server/src/modules/studio/public/profile-config');
    let hermes = {mcp_servers:{}};
    configureProfileConfig({providerEnvironmentMap:{}, updateConfigYamlForProfile:async (_profile, update)=>{
      const result=update(structuredClone(hermes)); if(result.write!==false) hermes=result.data; return result.result;
    }});
    function check(server) {
      assert(server); assert.equal(server.env.HERMES_MCP_TOOLSET,'plugins');
      assert.equal(server.env.ELECTRON_RUN_AS_NODE,'1');
    }
    (async()=>{
      const {injectBundledMcpServer} = require('./packages/server/src/modules/hermes/services/mcp/studio-autoinject');
      await injectBundledMcpServer(); check(hermes.mcp_servers['ekko-studio-plugins']);
      hermes.mcp_servers['ekko-studio-plugins'].enabled=false;
      await injectBundledMcpServer(); assert.equal(hermes.mcp_servers['ekko-studio-plugins'].enabled,false);
      const {injectManagedEkkoMcpServers} = require('./packages/server/src/modules/ekko/services/mcp');
      let value = {mcp:{profiles:{default:{servers:{}},work:{servers:{external:{command:'custom'}}}}}};
      const setup = {profiles:()=>[{profile:'work'}],config:{read:()=>value,replace:next=>{value=next}}};
      injectManagedEkkoMcpServers(setup);
      for(const profile of ['default','work']) check(value.mcp.profiles[profile].servers['ekko-studio-plugins']);
      value.mcp.profiles.work.servers['ekko-studio-plugins'].enabled=false;
      injectManagedEkkoMcpServers(setup);
      assert.equal(value.mcp.profiles.work.servers['ekko-studio-plugins'].enabled,false);
      assert.equal(value.mcp.profiles.work.servers.external.command,'custom');
      const {getCodingAgentManagedMcpServerConfigs:configs} = require('./packages/server/src/modules/coding-agents/services');
      for(const agent of ['claude-code','codex','pi','grok','opencode','dsh','cursor','antigravity','qwen','kimi','codebuddy','qoder','copilot']) {
        const server=configs(agent,'work','/test/auth.json')['ekko-studio-plugins'];
        const env=server.env||server.environment;
        check({env}); assert.equal(env.HERMES_WEB_UI_RUN_TOKEN_FILE,'/test/auth.json'); assert.equal(env.HERMES_WEB_UI_PROFILE,'work');
      }
      assert.deepEqual(configs('zcode'),{});
      const {setManagedMcpServerEnabled} = require('./packages/server/src/modules/coding-agents/services/mcp-overrides');
      setManagedMcpServerEnabled('codex','work','ekko-studio-plugins',false);
      assert.equal(configs('codex','work')['ekko-studio-plugins'].enabled,false);
      assert.notEqual(configs('codex','work')['ekko-studio-api'].enabled,false);
      process.stdout.write('managed plugin MCP configuration verified\\n',()=>process.exit(0));
    })().catch(error=>{console.error(error);process.exit(1)});
  `
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['-r', 'ts-node/register', '-e', script], {
      cwd: resolve('.'), timeout: 35000,
      env: { ...process.env, TS_NODE_PROJECT: 'packages/server/tsconfig.json', TS_NODE_COMPILER_OPTIONS: '{"rootDir":"."}', TS_NODE_FILES: 'true', TS_NODE_TRANSPILE_ONLY: 'true', HERMES_WEB_UI_HOME: dir, HERMES_HOME: join(dir, 'hermes'), HERMES_WEB_UI_ALLOW_TRANSIENT_MCP_AUTOINJECT: '1', HERMES_WEB_UI_DISABLE_MCP_AUTOINJECT: '' },
    })
    expect(stdout).toContain('managed plugin MCP configuration verified')
  } finally { await rm(dir, { recursive: true, force: true }) }
}, 40000)
