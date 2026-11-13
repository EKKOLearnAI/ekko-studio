import { getAgentUpdateManager, checkAgentUpdateAndPublish, installAgentAndPublish } from '../services/update-manager'
import type { Context } from 'koa'
import {
  deleteCodingAgent,
  getCodingAgentsStatus,
  openCodingAgentNativeTerminal,
  prepareCodingAgentLaunch,
  readCodingAgentConfigFile,
  sendCodingAgentRunInput,
  startCodingAgentRun,
  stopCodingAgentRun,
  writeCodingAgentConfigFile,
  type CodingAgentConfigScope,
} from '../services'
import {
  listCodingAgentMcpServers,
  removeCodingAgentMcpServer,
  testCodingAgentMcpServer,
  upsertCodingAgentMcpServer,
} from '../services/mcp-manager'

function configScope(ctx: Context): CodingAgentConfigScope {
  const body = ctx.request.body as { profile?: unknown; provider?: unknown } | undefined
  return {
    profile: ctx.state.profile?.name || (typeof ctx.query.profile === 'string' ? ctx.query.profile : '') || (typeof body?.profile === 'string' ? body.profile : ''),
    provider: (typeof ctx.query.provider === 'string' ? ctx.query.provider : '') || (typeof body?.provider === 'string' ? body.provider : ''),
  }
}

export async function status(ctx: Context) {
  try {
    ctx.body = await getCodingAgentsStatus()
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message || 'Failed to inspect coding agents' }
  }
}

export async function install(ctx: Context) {
  try {
    const result = await installAgentAndPublish(ctx.params.id, (ctx.request.body || {}) as { version?: string; rollback?: boolean })
    ctx.body = result
  } catch (err: any) {
    ctx.status = err.status || 500
    ctx.body = { error: err.message || 'Failed to install coding agent' }
  }
}

export async function checkUpdate(ctx: Context) {
  try {
    ctx.body = await checkAgentUpdateAndPublish(ctx.params.id)
  } catch (err: any) {
    ctx.status = err.status || 500
    ctx.body = { error: err.message || 'Failed to check coding agent update' }
  }
}

export async function remove(ctx: Context) {
  try {
    const result = await deleteCodingAgent(ctx.params.id)
    ctx.body = result
  } catch (err: any) {
    ctx.status = err.status || 500
    ctx.body = { error: err.message || 'Failed to delete coding agent' }
  }
}

export async function readConfigFile(ctx: Context) {
  try {
    ctx.body = await readCodingAgentConfigFile(ctx.params.id, ctx.params.key, configScope(ctx))
  } catch (err: any) {
    ctx.status = err.status || 500
    ctx.body = { error: err.message || 'Failed to read coding agent config file' }
  }
}

export async function writeConfigFile(ctx: Context) {
  try {
    const { content } = ctx.request.body as { content?: string }
    ctx.body = await writeCodingAgentConfigFile(ctx.params.id, ctx.params.key, content || '', configScope(ctx))
  } catch (err: any) {
    ctx.status = err.status || 500
    ctx.body = { error: err.message || 'Failed to write coding agent config file' }
  }
}

export async function listMcpServers(ctx: Context) {
  try {
    ctx.body = await listCodingAgentMcpServers(ctx.params.id, configScope(ctx))
  } catch (err: any) {
    ctx.status = err.status || 500
    ctx.body = { error: err.message || 'Failed to list coding agent MCP servers' }
  }
}

export async function addMcpServer(ctx: Context) {
  try {
    const body = (ctx.request.body || {}) as { name?: unknown; config?: unknown }
    ctx.body = await upsertCodingAgentMcpServer(
      ctx.params.id,
      typeof body.name === 'string' ? body.name : '',
      body.config as Record<string, any>,
      configScope(ctx),
    )
  } catch (err: any) {
    ctx.status = err.status || 500
    ctx.body = { error: err.message || 'Failed to add coding agent MCP server' }
  }
}

export async function updateMcpServer(ctx: Context) {
  try {
    const body = (ctx.request.body || {}) as { config?: unknown }
    ctx.body = await upsertCodingAgentMcpServer(
      ctx.params.id,
      ctx.params.name,
      body.config as Record<string, any>,
      configScope(ctx),
    )
  } catch (err: any) {
    ctx.status = err.status || 500
    ctx.body = { error: err.message || 'Failed to update coding agent MCP server' }
  }
}

export async function removeMcpServer(ctx: Context) {
  try {
    ctx.body = await removeCodingAgentMcpServer(ctx.params.id, ctx.params.name, configScope(ctx))
  } catch (err: any) {
    ctx.status = err.status || 500
    ctx.body = { error: err.message || 'Failed to remove coding agent MCP server' }
  }
}

export async function testMcpServer(ctx: Context) {
  try {
    ctx.body = await testCodingAgentMcpServer(ctx.params.id, ctx.params.name, configScope(ctx))
  } catch (err: any) {
    ctx.status = err.status || 503
    ctx.body = { error: err.message || 'Failed to test coding agent MCP server' }
  }
}

export async function prepareLaunch(ctx: Context) {
  try {
    const body = ctx.request.body as {
      mode?: any
      profile?: string
      provider?: string
      model?: string
      baseUrl?: string
      apiKey?: string
      apiMode?: any
    }
    ctx.body = await prepareCodingAgentLaunch(ctx.params.id, {
      mode: body.mode,
      profile: ctx.state.profile?.name || body.profile,
      provider: body.provider,
      model: body.model,
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
      apiMode: body.apiMode,
    })
  } catch (err: any) {
    ctx.status = err.status || 500
    ctx.body = { error: err.message || 'Failed to prepare coding agent launch' }
  }
}

export async function nativeLaunch(ctx: Context) {
  try {
    const body = ctx.request.body as {
      mode?: any
      profile?: string
      provider?: string
      model?: string
      baseUrl?: string
      apiKey?: string
      apiMode?: any
    }
    ctx.body = await openCodingAgentNativeTerminal(ctx.params.id, {
      mode: body.mode,
      profile: ctx.state.profile?.name || body.profile,
      provider: body.provider,
      model: body.model,
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
      apiMode: body.apiMode,
    })
  } catch (err: any) {
    ctx.status = err.status || 500
    ctx.body = { error: err.message || 'Failed to launch native terminal' }
  }
}

export async function startRun(ctx: Context) {
  try {
    const body = ctx.request.body as {
      sessionId?: string
      agentPreset?: string
      mode?: any
      profile?: string
      provider?: string
      model?: string
      baseUrl?: string
      apiKey?: string
      apiMode?: any
    }
    ctx.body = await startCodingAgentRun(ctx.params.id, {
      sessionId: String(body.sessionId || ''),
      agentPreset: body.agentPreset,
      mode: body.mode,
      profile: ctx.state.profile?.name || body.profile,
      provider: body.provider,
      model: body.model,
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
      apiMode: body.apiMode,
    })
  } catch (err: any) {
    ctx.status = err.status || 500
    ctx.body = { error: err.message || 'Failed to start coding agent run' }
  }
}

export async function sendRunInput(ctx: Context) {
  try {
    const body = ctx.request.body as { input?: string }
    ctx.body = await sendCodingAgentRunInput(String(ctx.params.sessionId || ''), String(body.input || ''))
  } catch (err: any) {
    ctx.status = err.status || 500
    ctx.body = { error: err.message || 'Failed to send coding agent input' }
  }
}

export async function stopRun(ctx: Context) {
  try {
    ctx.body = await stopCodingAgentRun(String(ctx.params.sessionId || ''))
  } catch (err: any) {
    ctx.status = err.status || 500
    ctx.body = { error: err.message || 'Failed to stop coding agent run' }
  }
}

export async function updatePolicies(ctx: Context) {
  ctx.body = { agents: (await getAgentUpdateManager()).snapshot() }
}
export async function setUpdatePolicy(ctx: Context) {
  try {
    const manager = await getAgentUpdateManager()
    await manager.set(ctx.params.id, (ctx.request.body as any)?.autoUpdate)
    ctx.body = { agents: manager.snapshot() }
  } catch (error) { ctx.status=400;ctx.body={error:error instanceof Error?error.message:'Invalid policy'} }
}
