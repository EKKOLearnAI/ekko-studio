import { once } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { prepareAntigravityRuntime } from '../../packages/server/src/modules/coding-agents/services/antigravity/config'
import { startAntigravityTurnProcess } from '../../packages/server/src/modules/coding-agents/services/antigravity/turn-process'
import { geminiToResponses } from '../../packages/server/src/modules/coding-agents/services/antigravity/gemini-adapter'

describe('real Antigravity headless image input', () => {
  it.skipIf(!process.env.ANTIGRAVITY_TEST_CLI)('opens uploaded images and retains tool-result bytes in the scoped bridge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agy-image-real-'))
    const workspace = join(root, 'workspace'), path = join(workspace, '图片 space.png')
    const requests: any[] = [], events: any[] = []
    let stderr = '', child: ChildProcess | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const server = createServer(async (request, response) => {
      let data = ''; for await (const chunk of request) data += chunk.toString()
      const body = JSON.parse(data || '{}'); requests.push(body)
      const view = (body.tools || []).flatMap((tool: any) => tool.functionDeclarations || []).find((tool: any) => tool.name === 'view_file')
      const viewed = (body.contents || []).some((content: any) => content.parts?.some((part: any) => part.functionResponse))
      const parts = view && !viewed ? [{ functionCall: { name: view.name, args: {
        AbsolutePath: path, toolSummary: 'Image inspection', toolAction: 'Inspecting image',
      } } }] : [{ text: 'IMAGE_OK' }]
      const result = { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 } }
      const stream = request.url?.includes('streamGenerateContent')
      response.setHeader('Content-Type', stream ? 'text/event-stream' : 'application/json')
      response.end(stream ? `data: ${JSON.stringify(result)}\n\n` : JSON.stringify(result))
    })
    try {
      await mkdir(workspace)
      await writeFile(path, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFElEQVQYlWP4z8CABzGMSjNgCQMAt8pjnanKDKUAAAAASUVORK5CYII=', 'base64'))
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const runtime = await prepareAntigravityRuntime({ home: root, rootDir: join(root, 'runtime'), systemPrompt: '', managedMcp: {},
        externalModel: { baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, token: 'local-test-token' } })
      const code = await new Promise<number | null>((resolve, reject) => {
        child = startAntigravityTurnProcess({ command: process.env.ANTIGRAVITY_TEST_CLI!, baseArgs: [], workspaceDir: workspace,
          env: { PATH: process.env.PATH, ...runtime.env }, nativeSessionId: '', resume: false,
          input: 'Inspect the image.', images: [{ path, name: '图片.png', mediaType: 'image/png' }],
          onEvent: event => events.push(event), onStderr: chunk => { stderr += chunk.toString() }, onError: reject, onClose: resolve })
        timer = setTimeout(() => reject(new Error(`Image check timed out: ${stderr.slice(-1000)}`)), 25000)
      })
      expect(code, stderr).toBe(0)
      expect(events.some(event => event.type === 'complete')).toBe(true)
      const images = requests.flatMap(body => geminiToResponses(body).input)
        .filter(input => input.type === 'function_call_output' && Array.isArray(input.output))
        .flatMap(input => input.output).filter(part => part.type === 'input_image')
      expect(images).toContainEqual({ type: 'input_image', image_url: expect.stringMatching(/^data:image\/png;base64,/) })
    } finally {
      clearTimeout(timer)
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close').catch(() => {})
        try { process.kill(process.platform === 'win32' ? child.pid! : -child.pid!, 'SIGKILL') } catch { child.kill('SIGKILL') }
        await closed
      }
      server.closeAllConnections(); server.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 35000)
})
