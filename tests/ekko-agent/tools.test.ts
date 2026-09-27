import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AgentToolError,
  DEFAULT_READ_FILE_MAX_BYTES,
  DEFAULT_TOOL_RESULT_MAX_TEXT_BYTES,
  DelegateTaskTool,
  ReadFileTool,
  TerminalExecTool,
  ViewImageTool,
  WriteFileTool,
  createDefaultToolRegistry,
  sanitizeAgentToolResult,
} from '../../packages/ekko-agent/src/index'

let workspaceRoot = ''

beforeEach(async () => {
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'ekko-agent-tools-'))
})

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true })
  delete process.env.AGENT_BROWSER_BIN
})

describe('ekko-agent tools', () => {
  it('materializes tool-result data URLs in the system temp area', async () => {
    const toolAssets = path.join(workspaceRoot, 'system-temp', 'ekko-agent', 'tool-assets')
    const dataUrl = `data:image/png;base64,${Buffer.from('avatar-png').toString('base64')}`
    const result = await sanitizeAgentToolResult({
      ok: true,
      content: JSON.stringify({
        profiles: [{
          name: 'default',
          avatar: { type: 'image', dataUrl, updatedAt: 123 },
        }],
      }),
      data: { avatar: { dataUrl } },
    }, { tempRoot: toolAssets })

    expect(result.content).not.toContain('base64')
    const parsed = JSON.parse(result.content)
    const url = parsed.profiles[0].avatar.dataUrl
    expect(url).toMatch(/^file:\/\//)
    expect(fileURLToPath(url)).toContain(toolAssets)
    await expect(readFile(fileURLToPath(url), 'utf8')).resolves.toBe('avatar-png')
    expect(JSON.stringify(result.data)).not.toContain('base64')
  })

  it('applies a provider-safe fallback limit to every textual tool result', async () => {
    const toolAssets = path.join(workspaceRoot, '.ekko-tmp', 'tool-assets')
    const content = `start-${'z'.repeat(DEFAULT_TOOL_RESULT_MAX_TEXT_BYTES)}-finish`
    const result = await sanitizeAgentToolResult({
      ok: true,
      content,
    }, {
      tempRoot: toolAssets,
      maxTextBytes: 120,
    })

    expect(Buffer.byteLength(result.content)).toBeLessThan(1_000)
    expect(result.content).toContain('tool result truncated')
    expect(result.content).toContain('start-')
    expect(result.content).toContain('-finish')
    const artifactPath = result.content.match(/Full output saved to (.+?); inspect it/)?.[1]
    expect(artifactPath).toBeTruthy()
    await expect(readFile(artifactPath!, 'utf8')).resolves.toBe(content)
    await expect(readFile(path.join(workspaceRoot, '.ekko-tmp', '.gitignore'), 'utf8')).resolves.toBe('*\n')
  })

  it('keeps a bounded text preview when the complete result cannot be persisted', async () => {
    const blockedTempRoot = path.join(workspaceRoot, 'blocked-tool-assets')
    const content = `start-${'z'.repeat(500)}-finish`
    await writeFile(blockedTempRoot, 'not-a-directory')

    const result = await sanitizeAgentToolResult({ ok: true, content }, {
      tempRoot: blockedTempRoot,
      maxTextBytes: 120,
    })

    expect(result.content).toContain('tool result truncated')
    expect(result.content).toContain('Full output could not be saved')
    expect(result.content).toContain('start-')
    expect(result.content).toContain('-finish')
  })

  it('caps persisted fallback text artifacts', async () => {
    const toolAssets = path.join(workspaceRoot, '.ekko-tmp', 'tool-assets')
    const content = `start-${'z'.repeat(500)}-finish`
    const result = await sanitizeAgentToolResult({ ok: true, content }, {
      tempRoot: toolAssets,
      maxTextBytes: 120,
      maxTextArtifactBytes: 64,
    })

    expect(result.content).toContain('first 64 bytes were saved')
    expect(result.content).toContain('artifact reached its safety limit')
    const artifactPath = result.content.match(/saved to (.+?); the artifact/)?.[1]
    expect(artifactPath).toBeTruthy()
    await expect(readFile(artifactPath!, 'utf8')).resolves.toBe(content.slice(0, 64))
  })

  it('writes and reads files inside the workspace', async () => {
    const writer = new WriteFileTool()
    const reader = new ReadFileTool()

    await expect(writer.execute({
      path: 'notes/todo.txt',
      content: 'ship tools',
    }, { workspaceRoot })).resolves.toMatchObject({
      ok: true,
      data: {
        bytes: 10,
      },
    })

    await expect(readFile(path.join(workspaceRoot, 'notes/todo.txt'), 'utf8')).resolves.toBe('ship tools')
    await expect(reader.execute({ path: 'notes/todo.txt' }, { workspaceRoot })).resolves.toMatchObject({
      ok: true,
      content: 'ship tools',
    })
  })

  it('bounds large file reads and supports continuing from the next byte offset', async () => {
    const reader = new ReadFileTool()
    const content = 'x'.repeat(DEFAULT_READ_FILE_MAX_BYTES + 25)
    await writeFile(path.join(workspaceRoot, 'large.txt'), content)

    const first = await reader.execute({
      path: 'large.txt',
      limit: DEFAULT_READ_FILE_MAX_BYTES * 2,
    }, { workspaceRoot })

    expect(first.content.startsWith('x'.repeat(DEFAULT_READ_FILE_MAX_BYTES))).toBe(true)
    expect(first.content).toContain(`[read_file truncated: returned bytes 0-${DEFAULT_READ_FILE_MAX_BYTES - 1} of ${content.length}; call again with offset=${DEFAULT_READ_FILE_MAX_BYTES}]`)
    expect(first.data).toMatchObject({
      bytes: DEFAULT_READ_FILE_MAX_BYTES,
      totalBytes: content.length,
      offset: 0,
      nextOffset: DEFAULT_READ_FILE_MAX_BYTES,
      truncated: true,
      limit: DEFAULT_READ_FILE_MAX_BYTES,
    })

    const second = await reader.execute({
      path: 'large.txt',
      offset: DEFAULT_READ_FILE_MAX_BYTES,
    }, { workspaceRoot })
    expect(second).toMatchObject({
      ok: true,
      content: 'x'.repeat(25),
      data: {
        bytes: 25,
        totalBytes: content.length,
        offset: DEFAULT_READ_FILE_MAX_BYTES,
        nextOffset: content.length,
        truncated: false,
      },
    })
  })

  it('does not split a UTF-8 code point at a read boundary', async () => {
    const reader = new ReadFileTool()
    await writeFile(path.join(workspaceRoot, 'unicode.txt'), 'aaaa😀z')

    const first = await reader.execute({ path: 'unicode.txt', limit: 5 }, { workspaceRoot })
    expect(first.content).toMatch(/^aaaa\n\n\[read_file truncated:/)
    expect(first.content).not.toContain('�')
    expect(first.data).toMatchObject({ bytes: 4, nextOffset: 4, truncated: true })

    await expect(reader.execute({ path: 'unicode.txt', offset: 4 }, { workspaceRoot })).resolves.toMatchObject({
      content: '😀z',
      data: { bytes: 5, nextOffset: 9, truncated: false },
    })
  })

  it('rejects invalid read ranges', async () => {
    const reader = new ReadFileTool()
    await writeFile(path.join(workspaceRoot, 'note.txt'), 'hello')

    await expect(reader.execute({ path: 'note.txt', offset: -1 }, { workspaceRoot }))
      .rejects.toMatchObject({ code: 'INVALID_TOOL_INPUT' })
    await expect(reader.execute({ path: 'note.txt', limit: 0 }, { workspaceRoot }))
      .rejects.toMatchObject({ code: 'INVALID_TOOL_INPUT' })
    await expect(reader.execute({ path: 'note.txt', limit: 3 }, { workspaceRoot }))
      .rejects.toMatchObject({ code: 'INVALID_TOOL_INPUT' })
  })

  it('reads files outside workspaceRoot while keeping writes isolated', async () => {
    const reader = new ReadFileTool()
    const writer = new WriteFileTool()
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'ekko-agent-tools-outside-'))
    const outsideFile = path.join(outsideRoot, 'outside.txt')
    await writeFile(outsideFile, 'outside workspace')

    try {
      await expect(reader.execute({ path: outsideFile }, { workspaceRoot })).resolves.toMatchObject({
        ok: true,
        content: 'outside workspace',
        data: { path: outsideFile },
      })
      await expect(reader.execute({
        path: path.relative(workspaceRoot, outsideFile),
      }, { workspaceRoot })).resolves.toMatchObject({
        ok: true,
        content: 'outside workspace',
      })
      await expect(writer.execute({
        path: outsideFile,
        content: 'must remain blocked',
      }, { workspaceRoot })).rejects.toBeInstanceOf(AgentToolError)
      await expect(writer.execute({
        path: outsideFile,
        content: 'must remain blocked',
      }, { workspaceRoot })).rejects.toMatchObject({
        code: 'PATH_OUTSIDE_WORKSPACE',
      })
    } finally {
      await rm(outsideRoot, { recursive: true, force: true })
    }
  })

  it('loads supported workspace images as multimodal tool results', async () => {
    const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    )
    await writeFile(path.join(workspaceRoot, 'preview.png'), image)
    const viewer = new ViewImageTool()

    await expect(viewer.execute({ path: 'preview.png' }, { workspaceRoot })).resolves.toMatchObject({
      ok: true,
      contentParts: [{
        type: 'image',
        mimeType: 'image/png',
        data: image.toString('base64'),
      }],
      data: {
        path: path.join(workspaceRoot, 'preview.png'),
        bytes: image.byteLength,
        mimeType: 'image/png',
      },
    })
  })

  it('reports a recoverable view_image failure when the current model is text-only', async () => {
    const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    )
    await writeFile(path.join(workspaceRoot, 'text-only-preview.png'), image)
    const viewer = new ViewImageTool()

    const result = await viewer.execute({ path: 'text-only-preview.png' }, {
      workspaceRoot,
      modelProvider: 'glm',
      modelName: 'glm-5.3',
      modelCapabilities: {
        streaming: true,
        tools: true,
        vision: false,
        jsonMode: true,
        systemPrompt: true,
      },
    })

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('glm/glm-5.3 does not support vision input'),
      data: {
        code: 'VISION_UNSUPPORTED',
        path: path.join(workspaceRoot, 'text-only-preview.png'),
        bytes: image.byteLength,
        mimeType: 'image/png',
      },
    })
    expect(result).not.toHaveProperty('contentParts')
  })

  it('enforces workspace and format boundaries when viewing images', async () => {
    const viewer = new ViewImageTool()
    await writeFile(path.join(workspaceRoot, 'not-an-image.png'), 'plain text')

    await expect(viewer.execute({ path: '../outside.png' }, { workspaceRoot }))
      .rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' })
    await expect(viewer.execute({ path: 'not-an-image.png' }, { workspaceRoot }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_IMAGE_FORMAT' })
  })

  it('runs terminal commands with argument arrays', async () => {
    const terminal = new TerminalExecTool()

    await expect(terminal.execute({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(process.argv[1])', 'hello-terminal'],
    }, { workspaceRoot })).resolves.toMatchObject({
      ok: true,
      content: 'hello-terminal',
      data: {
        args: ['-e', 'process.stdout.write(process.argv[1])', 'hello-terminal'],
        exitCode: 0,
      },
    })
  })

  it('bounds terminal output and saves the complete streams for paged inspection', async () => {
    const terminal = new TerminalExecTool({ maxOutputBytes: 90, maxStderrBytes: 30 })
    const stdout = `head-${'x'.repeat(180)}-tail`
    const stderr = `error-${'y'.repeat(60)}-end`
    const result = await terminal.execute({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(process.argv[1]); process.stderr.write(process.argv[2])', stdout, stderr],
    }, { workspaceRoot, runId: 'large-output-test' })

    expect(result.ok).toBe(true)
    expect(Buffer.byteLength(result.content)).toBeLessThan(1_000)
    expect(result.content).toContain('terminal_exec output truncated')
    expect(result.content).toContain('inspect it with read_file using offsets or a bounded search')
    expect(result.data).toMatchObject({
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: Buffer.byteLength(stderr),
      stdoutTruncated: true,
      stderrTruncated: true,
    })
    const data = result.data as {
      stdoutArtifactPath: string
      stderrArtifactPath: string
    }
    await expect(readFile(data.stdoutArtifactPath, 'utf8')).resolves.toBe(stdout)
    await expect(readFile(data.stderrArtifactPath, 'utf8')).resolves.toBe(stderr)
  })

  it('caps persisted terminal artifacts while continuing to drain command output', async () => {
    const terminal = new TerminalExecTool({ maxOutputBytes: 40, maxArtifactBytes: 64 })
    const stdout = `head-${'x'.repeat(180)}-tail`
    const result = await terminal.execute({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(process.argv[1])', stdout],
    }, { workspaceRoot, runId: 'artifact-cap-test' })

    expect(result).toMatchObject({
      ok: true,
      data: {
        stdoutBytes: Buffer.byteLength(stdout),
        stdoutTruncated: true,
        stdoutArtifactBytes: 64,
        stdoutArtifactTruncated: true,
      },
    })
    expect(result.content).toContain('artifact reached its safety limit')
    const artifactPath = (result.data as { stdoutArtifactPath: string }).stdoutArtifactPath
    await expect(readFile(artifactPath, 'utf8')).resolves.toBe(stdout.slice(0, 64))
  })

  it('removes terminal artifacts when output stays within the context limit', async () => {
    const terminal = new TerminalExecTool({ maxOutputBytes: 100, maxStderrBytes: 100 })
    const result = await terminal.execute({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("small")'],
    }, { workspaceRoot, runId: 'small-output-test' })

    expect(result).toMatchObject({
      ok: true,
      content: 'small',
      data: {
        stdout: 'small',
        stdoutBytes: 5,
        stdoutTruncated: false,
        stderrBytes: 0,
        stderrTruncated: false,
      },
    })
    expect(result.data).not.toHaveProperty('stdoutArtifactPath')
    expect(result.data).not.toHaveProperty('stderrArtifactPath')
    await expect(readdir(path.join(workspaceRoot, '.ekko-tmp', 'tool-assets'))).resolves.toEqual([])
  })

  it('defaults command temporary files to the current workspace', async () => {
    const terminal = new TerminalExecTool()
    const result = await terminal.execute({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify({ TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP }))'],
    }, { workspaceRoot })
    const expected = path.join(workspaceRoot, '.ekko-tmp')

    expect(result.ok).toBe(true)
    expect(JSON.parse(result.content)).toEqual({ TMPDIR: expected, TMP: expected, TEMP: expected })
    expect((await stat(expected)).isDirectory()).toBe(true)
    await expect(readFile(path.join(expected, '.gitignore'), 'utf8')).resolves.toBe('*\n')
  })

  it('allows an explicit terminal working directory outside workspaceRoot', async () => {
    const terminal = new TerminalExecTool()
    const cwd = os.tmpdir()

    const result = await terminal.execute({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(process.cwd())'],
      cwd,
    }, { workspaceRoot })
    expect(result).toMatchObject({
      ok: true,
      data: { cwd },
    })
    expect(await realpath(result.content)).toBe(await realpath(cwd))
  })

  it('normalizes shell-like terminal command strings when args are omitted', async () => {
    const terminal = new TerminalExecTool()

    const executable = process.execPath.includes(' ') ? `"${process.execPath}"` : process.execPath
    await expect(terminal.execute({
      command: `${executable} -e "process.stdout.write(process.argv[1])" hello-split`,
    }, { workspaceRoot })).resolves.toMatchObject({
      ok: true,
      content: 'hello-split',
      data: {
        command: process.execPath,
        args: ['-e', 'process.stdout.write(process.argv[1])', 'hello-split'],
        exitCode: 0,
      },
    })
  })

  it('does not start terminal commands when the signal is already aborted', async () => {
    const terminal = new TerminalExecTool()
    const controller = new AbortController()
    controller.abort()

    await expect(terminal.execute({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("should-not-run")'],
    }, { workspaceRoot, signal: controller.signal })).resolves.toMatchObject({
      ok: false,
      content: 'Command aborted.',
      error: 'Command aborted.',
      data: {
        aborted: true,
      },
    })
  })

  it('reports non-zero terminal exits without throwing', async () => {
    const terminal = new TerminalExecTool()

    await expect(terminal.execute({
      command: process.execPath,
      args: ['-e', 'process.stderr.write("bad"); process.exit(7)'],
    }, { workspaceRoot })).resolves.toMatchObject({
      ok: false,
      content: 'bad',
      error: 'Command exited with code 7',
      data: {
        exitCode: 7,
      },
    })
  })

  it('registers default tools and exposes model definitions', async () => {
    const registry = createDefaultToolRegistry()
    const definitions = registry.definitions()

    expect(definitions.map(definition => definition.name).sort()).toEqual([
      'browser_back',
      'browser_click',
      'browser_console',
      'browser_get_images',
      'browser_navigate',
      'browser_press',
      'browser_scroll',
      'browser_snapshot',
      'browser_type',
      'browser_vision',
      'code_exec',
      'delegate_task',
      'read_file',
      'skill_list',
      'skill_view',
      'terminal_exec',
      'update_plan',
      'view_image',
      'write_file',
    ])
    const definitionsByName = new Map(definitions.map(definition => [definition.name, definition]))
    expect(definitionsByName.get('code_exec')?.description).toContain('including a one-line snippet')
    expect(definitionsByName.get('terminal_exec')?.description).toContain('use code_exec instead')
    expect(definitionsByName.get('terminal_exec')?.description).toContain(
      process.platform === 'win32' ? 'explicit absolute Windows paths are supported' : 'npx --dir',
    )
    for (const definition of definitions) {
      expect(definition.description, definition.name).not.toMatch(/[\p{Script=Han}]/u)
      for (const description of collectDescriptions(definition.parameters)) {
        expect(description, definition.name).not.toMatch(/[\p{Script=Han}]/u)
      }
    }

    await expect(registry.execute('write_file', {
      path: 'from-registry.txt',
      content: 'ok',
    }, { workspaceRoot })).resolves.toMatchObject({ ok: true })

    await expect(registry.execute('read_file', {
      path: 'from-registry.txt',
    }, { workspaceRoot })).resolves.toMatchObject({
      ok: true,
      content: 'ok',
    })
  })

  it('describes Windows-native terminal commands without Unix defaults', () => {
    const definition = new TerminalExecTool({ platform: 'win32' }).definition

    expect(definition.description).toContain('This runtime is Windows')
    expect(definition.description).toContain('Do not use Unix-only commands')
    expect(definition.description).toContain('cmd.exe')
    expect(definition.description).toContain('.cmd or .bat launchers')
    expect(definition.description).toContain('powershell.exe')
    expect(definition.description).not.toContain('npx --dir')
    expect(definition.parameters.properties?.command?.description).toContain('git.exe')
  })

  it('describes macOS terminal semantics separately from Windows', () => {
    const definition = new TerminalExecTool({ platform: 'darwin' }).definition

    expect(definition.description).toContain('This runtime is macOS')
    expect(definition.description).toContain('BSD rather than GNU')
    expect(definition.description).toContain('sh or zsh')
    expect(definition.description).not.toContain('generate Windows-native commands')
  })

  it('delegates foreground and background tasks through the runtime callback', async () => {
    const tool = new DelegateTaskTool()
    const requests: unknown[] = []
    const delegateTask = async (request: unknown) => {
      requests.push(request)
      return { ok: true, content: 'delegated' }
    }

    await expect(tool.execute({
      goal: 'Inspect the failing test',
      context: 'Only read files under tests/',
      mode: 'foreground',
    }, { delegateTask })).resolves.toMatchObject({
      ok: true,
      content: 'delegated',
    })
    await expect(tool.execute({
      goal: 'Run the slow validation',
      mode: 'background',
    }, { delegateTask })).resolves.toMatchObject({
      ok: true,
      content: 'delegated',
    })

    expect(requests).toEqual([{
      goal: 'Inspect the failing test',
      context: 'Only read files under tests/',
      mode: 'foreground',
    }, {
      goal: 'Run the slow validation',
      mode: 'background',
    }])
  })

  it('rejects recursive or unavailable delegation', async () => {
    const tool = new DelegateTaskTool()

    await expect(tool.execute({
      goal: 'Delegate again',
      mode: 'foreground',
    }, {
      delegationDepth: 1,
      delegateTask: async () => ({ ok: true, content: 'unexpected' }),
    })).resolves.toMatchObject({
      ok: false,
      error: 'Recursive delegation is disabled for Ekko subagents.',
    })

    await expect(tool.execute({
      goal: 'No runtime callback',
      mode: 'background',
    })).resolves.toMatchObject({
      ok: false,
      error: 'Subtask delegation is unavailable in this runtime.',
    })
  })
})

function collectDescriptions(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(collectDescriptions)
  const record = value as Record<string, unknown>
  return [
    ...(typeof record.description === 'string' ? [record.description] : []),
    ...Object.values(record).flatMap(collectDescriptions),
  ]
}
