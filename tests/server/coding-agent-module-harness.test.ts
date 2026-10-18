import { expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error Harness scripts are plain Node modules.
import { checkCodingAgentModuleBoundaries, codingAgentModuleViolations } from '../../scripts/coding-agent-module-harness.mjs'

const root = 'packages/server/src/modules/coding-agents/'

it('keeps agent implementations out of shared orchestration and the old native directory', () => {
  const source = 'export function prepareZcodeScopedRuntime() {}'
  expect(codingAgentModuleViolations(`${root}services/zcode/runtime-config.ts`, source)).toEqual([])
  expect(codingAgentModuleViolations(`${root}services/index.ts`, source)).toHaveLength(1)
  expect(codingAgentModuleViolations(`${root}services/native/runtime-config.ts`, source)).toHaveLength(2)
  expect(codingAgentModuleViolations(`${root}services/registry/native-agents.ts`, "import { prepareZcodeScopedRuntime } from '../zcode/runtime-config'")).toEqual([])
})

it('keeps reusable ACP in the protocol directory', () => {
  const source = 'export class NativeAcpTurn {}'
  expect(codingAgentModuleViolations(`${root}protocol/acp/turn.ts`, source)).toEqual([])
  expect(codingAgentModuleViolations(`${root}services/qwen/acp.ts`, source)).toHaveLength(1)
})

it('requires concrete agents to receive helpers instead of importing the registry', () => {
  expect(codingAgentModuleViolations(`${root}services/opencode/config.ts`, "import { getCodingAgentDefinition } from '../index'")).toHaveLength(1)
  expect(codingAgentModuleViolations(`${root}services/kimi/config.ts`, "import { NATIVE_CODING_AGENTS } from '../registry/native-agents'")).toHaveLength(1)
  expect(codingAgentModuleViolations(`${root}services/codex/usage.ts`, "import type { NativeUsageRow } from '../runtime/native-usage'")).toEqual([])
})

it('requires every runtime in the Studio contract to have an owned definition', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'coding-agent-boundaries-'))
  try {
    const contracts = join(fixture, 'packages/server/src/modules/studio/contracts/agents')
    const qwen = join(fixture, root, 'services/qwen')
    await mkdir(contracts, { recursive: true })
    await mkdir(qwen, { recursive: true })
    await writeFile(join(contracts, 'runtime.ts'), "type CodingAgentRuntime = Extract<AgentRuntime, 'qwen' | 'new-cli'>")
    await writeFile(join(qwen, 'definition.ts'), "export const QWEN_DEFINITION = { id: 'qwen' }")
    expect(await checkCodingAgentModuleBoundaries(fixture)).toEqual([
      `Missing Coding Agent definition: ${root}services/new-cli/definition.ts`,
    ])
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})
