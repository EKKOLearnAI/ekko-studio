import { NativeAcpTurn } from '../../protocol/acp/turn'
import { acpMcpServers, applyNativeAcpUpdate } from '../../protocol/acp/events'
import type { ManagedCodingAgentRun } from './run-manager'
import type { NativeTurnHost } from './turn-host'
import { startNativeTurnProcess } from './native-turn-process'
import type { CodingAgentImageInput } from '../../protocol/types'

export function startAcpChatTurn(definition: { name: string; acpArgs: readonly string[] }, run: ManagedCodingAgentRun, input: string, systemPrompt: string, host: NativeTurnHost, images: CodingAgentImageInput[] = []) {
  const { child, text, session, finish, isFinished } = startNativeTurnProcess(run, input, systemPrompt, host, {
    name: definition.name, args: () => [...run.launch.args, ...definition.acpArgs],
    emptyPrompt: images.length ? 'Inspect the attached images.' : '',
  })
  let connection: NativeAcpTurn | undefined
  connection = new NativeAcpTurn(child, {
    session, permissionRequired: run.launch.approvalRequired,
    update: update => { if (!run.exited && !run.stoppedByUser && !isFinished()) { host.touch(); applyNativeAcpUpdate(update, host) } },
  })
  run.nativeAcpTurn = connection
  void connection.prompt({ cwd: run.launch.workspaceDir, text, images,
    nativeSessionId: run.nativeResumeReady ? run.launch.agentNativeSessionId : undefined,
    mcpServers: acpMcpServers(run.launch.nativeMcpServers || {}),
  }).then(reason => finish(['end_turn', 'max_tokens'].includes(reason) ? undefined : `${definition.name} stopped: ${reason}`))
    .catch(error => { finish(host.processError(error)); host.terminate(child) })
    .finally(() => {
      connection?.dispose()
      if (run.nativeAcpTurn === connection) run.nativeAcpTurn = undefined
      if (host.isRunning(child)) run.currentChildKillTimer = setTimeout(() => host.forceKill(child), 1500)
    })
}
