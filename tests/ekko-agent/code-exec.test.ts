import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CodeExecTool,
  createDefaultToolRegistry,
  type AgentToolResult,
} from '../../packages/ekko-agent/src'

let workspaceRoot = ''

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'ekko-code-exec-test-'))
})

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true })
  delete process.env.EKKO_CODE_EXEC_TEST_SECRET
})

describe('code_exec', () => {
  it('runs Node.js code with programmatic Ekko tool calls', async () => {
    await writeFile(join(workspaceRoot, 'input.txt'), 'hello from node')
    const registry = createDefaultToolRegistry()

    const result = await registry.execute('code_exec', {
      language: 'node',
      code: [
        "import { read_file } from './ekko_tools.mjs'",
        "const result = await read_file({ path: 'input.txt' })",
        'console.log(result.content.toUpperCase())',
      ].join('\n'),
    }, { workspaceRoot })

    expect(result.ok).toBe(true)
    expect(JSON.parse(result.content)).toMatchObject({
      status: 'completed',
      language: 'node',
      output: 'HELLO FROM NODE\n',
      toolCallsMade: 1,
      exitCode: 0,
    })
  })

  it.runIf(Boolean(findPythonExecutable()))(
    'runs Python code with programmatic Ekko tool calls',
    async () => {
      await writeFile(join(workspaceRoot, 'input.txt'), 'hello from python')
      const registry = createDefaultToolRegistry()
      const tool = new CodeExecTool({
        pythonExecutable: findPythonExecutable(),
        dispatch: (name, input, context) => registry.execute(name, input, context),
      })

      const result = await tool.execute({
        language: 'python',
        code: [
          'from ekko_tools import read_file',
          'result = read_file(path="input.txt")',
          'print(result["content"].upper())',
        ].join('\n'),
      }, { workspaceRoot })

      expect(result.ok).toBe(true)
      expect(JSON.parse(result.content)).toMatchObject({
        status: 'completed',
        language: 'python',
        output: `HELLO FROM PYTHON${process.platform === 'win32' ? '\r\n' : '\n'}`,
        toolCallsMade: 1,
        exitCode: 0,
      })
    },
  )

  it('enforces the nested tool-call limit', async () => {
    const tool = new CodeExecTool({
      maxToolCalls: 2,
      dispatch: async (): Promise<AgentToolResult> => ({ ok: true, content: 'ok' }),
    })

    const result = await tool.execute({
      language: 'node',
      code: [
        "import { read_file } from './ekko_tools.mjs'",
        "await read_file({ path: 'one' })",
        "await read_file({ path: 'two' })",
        "const third = await read_file({ path: 'three' })",
        'console.log(third.error)',
      ].join('\n'),
    }, { workspaceRoot })

    expect(result.ok).toBe(true)
    expect(JSON.parse(result.content)).toMatchObject({
      toolCallsMade: 2,
      output: 'code_exec exceeded its 2-tool-call limit.\n',
    })
  })

  it('rejects recursive and non-allowlisted nested tools', async () => {
    let dispatchCalls = 0
    const tool = new CodeExecTool({
      dispatch: async () => {
        dispatchCalls += 1
        return { ok: true, content: 'unexpected' }
      },
    })

    const result = await tool.execute({
      language: 'node',
      code: [
        "import { callTool } from './ekko_tools.mjs'",
        "const nested = await callTool('code_exec', { language: 'node', code: '' })",
        'console.log(nested.error)',
      ].join('\n'),
    }, { workspaceRoot })

    expect(result.ok).toBe(true)
    expect(JSON.parse(result.content)).toMatchObject({
      toolCallsMade: 0,
      output: 'Tool "code_exec" is unavailable inside code_exec.\n',
    })
    expect(dispatchCalls).toBe(0)
  })

  it('scrubs unapproved environment variables from child runtimes', async () => {
    process.env.EKKO_CODE_EXEC_TEST_SECRET = 'must-not-leak'
    const tool = new CodeExecTool({
      dispatch: async () => ({ ok: true, content: 'unused' }),
    })

    const result = await tool.execute({
      language: 'node',
      code: 'console.log(process.env.EKKO_CODE_EXEC_TEST_SECRET || "scrubbed")',
    }, { workspaceRoot })

    expect(result.ok).toBe(true)
    expect(JSON.parse(result.content)).toMatchObject({
      output: 'scrubbed\n',
    })
  })

  it('keeps code runtime temporary files under the current workspace', async () => {
    const tool = new CodeExecTool({
      dispatch: async () => ({ ok: true, content: 'unused' }),
    })

    const result = await tool.execute({
      language: 'node',
      code: 'console.log(process.env.TMPDIR)',
    }, { workspaceRoot })

    expect(result.ok).toBe(true)
    expect(JSON.parse(result.content)).toMatchObject({
      output: `${join(workspaceRoot, '.ekko-tmp')}\n`,
    })
  })

  it('terminates scripts at the configured timeout', async () => {
    const tool = new CodeExecTool({
      timeoutMs: 50,
      dispatch: async () => ({ ok: true, content: 'unused' }),
    })

    const result = await tool.execute({
      language: 'node',
      code: 'await new Promise(resolve => setTimeout(resolve, 10_000))',
    }, { workspaceRoot })

    expect(result).toMatchObject({
      ok: false,
      error: 'Code execution timed out after 50ms.',
      data: {
        timedOut: true,
        language: 'node',
      },
    })
  })

  it('rejects unsupported languages before starting a child process', async () => {
    const tool = new CodeExecTool({
      dispatch: async () => ({ ok: true, content: 'unused' }),
    })

    await expect(tool.execute({
      language: 'ruby' as any,
      code: 'puts "no"',
    }, { workspaceRoot })).resolves.toMatchObject({
      ok: false,
      error: 'code_exec language must be one of: node, python.',
    })
  })

  it('honors the configured language allowlist', async () => {
    const tool = new CodeExecTool({
      allowedLanguages: ['node'],
      dispatch: async () => ({ ok: true, content: 'unused' }),
    })

    await expect(tool.execute({
      language: 'python',
      code: 'print("no")',
    }, { workspaceRoot })).resolves.toMatchObject({
      ok: false,
      error: 'code_exec language must be one of: node.',
    })
    expect(tool.definition.parameters).toMatchObject({
      properties: { language: { enum: ['node'] } },
    })
  })
})

function findPythonExecutable(): string | undefined {
  for (const command of [process.env.PYTHON, 'python3', 'python']) {
    if (!command) continue
    const result = spawnSync(command, ['--version'], {
      shell: false,
      timeout: 2_000,
      windowsHide: true,
    })
    if (!result.error && result.status === 0) return command
  }
  return undefined
}
