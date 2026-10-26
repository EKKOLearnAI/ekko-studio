// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { BrowserAutomation } from '../../packages/desktop/src/main/browser/browser-automation'
import {
  BROWSER_DOWNLOAD_CHUNK_BYTES, BrowserDownloadStore, DOWNLOAD_SOURCE_FUNCTION, UPLOAD_FUNCTION,
  fileNameFromResponse, parseBrowserUploadFiles, parseBrowserUploadMethod, readLimitedBody,
} from '../../packages/desktop/src/main/browser/browser-files'

// jsdom has no DataTransfer; a list-backed stand-in is enough for the page script.
class FakeDataTransfer {
  files: File[] = []
  items = { add: (file: File) => { this.files.push(file) } }
}

function pageFunction(source: string) {
  return new Function(`return (${source})`)() as (this: Node, ...args: unknown[]) => any
}

function trackFiles(input: HTMLInputElement) {
  let files: unknown = null
  Object.defineProperty(input, 'files', { get: () => files, set: value => { files = value } })
  return () => files as File[]
}

describe('browser upload page script', () => {
  const upload = pageFunction(UPLOAD_FUNCTION)
  const png = { name: 'a.png', type: 'image/png', data: Buffer.from([1, 2, 3]).toString('base64') }

  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('fills the hidden file input next to a visible upload button', () => {
    vi.stubGlobal('DataTransfer', FakeDataTransfer)
    document.body.innerHTML = '<div><button>Add photo</button><input type="file" hidden></div>'
    const input = document.querySelector('input')!
    const files = trackFiles(input)
    const events: string[] = []
    input.addEventListener('input', () => events.push('input'))
    input.addEventListener('change', () => events.push('change'))

    const result = upload.call(document.querySelector('button')!, [png], 'auto')
    expect(result).toEqual({ method: 'input', files: [{ name: 'a.png', type: 'image/png', size: 3 }] })
    expect(files()[0].name).toBe('a.png')
    expect(events).toEqual(['input', 'change'])
  })

  it('rejects several files for a single-file input and ambiguous inputs for method=input', () => {
    vi.stubGlobal('DataTransfer', FakeDataTransfer)
    document.body.innerHTML = '<input type="file">'
    expect(() => upload.call(document.querySelector('input')!, [png, png], 'input')).toThrow('only one file')
    document.body.innerHTML = '<section><div id="zone">Drop</div><input type="file"><input type="file"></section>'
    expect(() => upload.call(document.getElementById('zone')!, [png], 'input')).toThrow('No file input')
  })

  it('drops files on a dropzone without a file input', () => {
    vi.stubGlobal('DataTransfer', FakeDataTransfer)
    vi.stubGlobal('DragEvent', class extends Event {
      dataTransfer: unknown
      constructor(type: string, init: EventInit & { dataTransfer?: unknown }) { super(type, init); this.dataTransfer = init.dataTransfer }
    })
    document.body.innerHTML = '<div id="zone">Drop files here</div>'
    const zone = document.getElementById('zone')!
    zone.scrollIntoView = () => {}
    const seen: Array<[string, number]> = []
    for (const type of ['dragenter', 'dragover', 'drop']) {
      zone.addEventListener(type, event => seen.push([type, (event as any).dataTransfer.files.length]))
    }
    expect(upload.call(zone, [png], 'auto').method).toBe('drop')
    expect(seen).toEqual([['dragenter', 1], ['dragover', 1], ['drop', 1]])
  })
})

describe('browser download helpers', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('resolves link, image and non-media targets', () => {
    const source = pageFunction(DOWNLOAD_SOURCE_FUNCTION)
    document.body.innerHTML = '<a href="/files/report.pdf" download="Q3.pdf"><span>Report</span></a><img src="https://cdn.example.com/a.png"><p>text</p>'
    expect(source.call(document.querySelector('span')!.firstChild!)).toEqual({ url: 'http://localhost:3000/files/report.pdf', fileName: 'Q3.pdf' })
    expect(source.call(document.querySelector('img')!)).toEqual({ url: 'https://cdn.example.com/a.png', fileName: '' })
    expect(() => source.call(document.querySelector('p')!)).toThrow('not a link')
  })

  it('names files from the suggestion, Content-Disposition or URL', () => {
    expect(fileNameFromResponse('https://x.test/a', null, '../../etc/passwd')).toBe('passwd')
    expect(fileNameFromResponse('https://x.test/a', `attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf`)).toBe('报告.pdf')
    expect(fileNameFromResponse('https://x.test/a', 'attachment; filename="a:b.txt"')).toBe('a_b.txt')
    expect(fileNameFromResponse('https://x.test/dir/photo%201.jpg?x=1', null)).toBe('photo 1.jpg')
    expect(fileNameFromResponse('blob:https://x.test/uuid', null)).toBe('download')
  })

  it('serves a download in chunks once and then forgets it', () => {
    const store = new BrowserDownloadStore()
    const buffer = Buffer.alloc(BROWSER_DOWNLOAD_CHUNK_BYTES + 10, 7)
    const info = store.add(buffer, { fileName: 'a.bin', mimeType: 'Application/Octet-Stream', sourceUrl: 'https://x.test/a.bin' })
    expect(info).toMatchObject({ fileName: 'a.bin', mimeType: 'application/octet-stream', size: buffer.length })
    const first = store.read(info.downloadId, 0)
    expect(first).toMatchObject({ returnedBytes: BROWSER_DOWNLOAD_CHUNK_BYTES, done: false, nextOffset: BROWSER_DOWNLOAD_CHUNK_BYTES })
    const last = store.read(info.downloadId, first.nextOffset!)
    expect(last).toMatchObject({ returnedBytes: 10, done: true })
    expect(Buffer.concat([Buffer.from(first.data, 'base64'), Buffer.from(last.data, 'base64')]).equals(buffer)).toBe(true)
    expect(() => store.read(info.downloadId, 0)).toThrow('expired')
    expect(() => store.add(Buffer.alloc(21 * 1024 * 1024), { fileName: 'x', mimeType: '', sourceUrl: '' })).toThrow('20 MB')
    store.clear()
  })

  it('stops reading a response body past the limit', async () => {
    await expect(readLimitedBody(new Response('hello'), 10)).resolves.toEqual(Buffer.from('hello'))
    await expect(readLimitedBody(new Response('hello world'), 5)).rejects.toThrow('limit')
    await expect(readLimitedBody(new Response('x', { headers: { 'content-length': '99' } }), 5)).rejects.toThrow('limit')
  })

  it('validates upload files and methods', () => {
    expect(parseBrowserUploadFiles([{ name: 'C:\\tmp\\a<b>.png', type: 'image/png', data: 'AAEC' }]))
      .toEqual([{ name: 'a_b_.png', type: 'image/png', data: 'AAEC' }])
    expect(() => parseBrowserUploadFiles([])).toThrow('1 to 4')
    expect(() => parseBrowserUploadFiles([{ name: 'a', data: 'not base64!' }])).toThrow('base64')
    expect(() => parseBrowserUploadFiles([{ name: 'a', data: Buffer.alloc(11 * 1024 * 1024).toString('base64') }])).toThrow('10 MB')
    expect(parseBrowserUploadMethod(undefined)).toBe('auto')
    expect(() => parseBrowserUploadMethod('clipboard')).toThrow('method')
  })
})

describe('browser hover, select, upload and wait over CDP', () => {
  function contents(runtime: (params: Record<string, any>) => unknown, pageText = () => '') {
    const commands: Array<{ method: string; params: Record<string, any> }> = []
    let attached = false
    return {
      commands,
      contents: {
        debugger: {
          isAttached: () => attached, attach: () => { attached = true }, detach: () => { attached = false },
          sendCommand: async (method: string, params: Record<string, any> = {}) => {
            commands.push({ method, params })
            if (method === 'Accessibility.getFullAXTree') return { nodes: [{ backendDOMNodeId: 7, role: { value: 'button' }, name: { value: 'Upload' } }] }
            if (method === 'DOM.resolveNode') return { object: { objectId: 'object-1' } }
            if (method === 'DOM.describeNode') return { node: { nodeName: 'BUTTON', attributes: [] } }
            if (method === 'Runtime.callFunctionOn') return runtime(params)
            if (method === 'Runtime.evaluate') {
              const text = pageText()
              return { result: { value: { has: text.includes('Done'), gone: true } } }
            }
            return {}
          },
        },
        isDestroyed: () => false, getURL: () => 'https://example.com/', getTitle: () => 'Example',
      } as unknown as WebContents,
    }
  }

  it('hovers with a trusted mouse move at the element center', async () => {
    const automation = new BrowserAutomation()
    const fake = contents(() => ({ result: { value: { x: 40, y: 12 } } }))
    const snapshot = await automation.snapshot('tab-1', fake.contents)
    await automation.interact('tab-1', fake.contents, { action: 'hover', snapshot_id: snapshot.snapshotId, ref: '@e1' })
    expect(fake.commands.find(command => command.method === 'Input.dispatchMouseEvent')?.params).toEqual({ type: 'mouseMoved', x: 40, y: 12 })
  })

  it('selects by value and reports page script errors', async () => {
    const automation = new BrowserAutomation()
    let fail = false
    const fake = contents(params => fail
      ? { exceptionDetails: { exception: { description: 'Error: No option matches the requested value or label\n at x' } } }
      : { result: { value: params.arguments?.[0]?.value === 'cn' } })
    let snapshot = await automation.snapshot('tab-1', fake.contents)
    await automation.interact('tab-1', fake.contents, { action: 'select', snapshot_id: snapshot.snapshotId, ref: '@e1', value: 'cn' })
    fail = true
    snapshot = await automation.snapshot('tab-1', fake.contents)
    await expect(automation.interact('tab-1', fake.contents, { action: 'select', snapshot_id: snapshot.snapshotId, ref: '@e1', value: 'xx' }))
      .rejects.toThrow('Unable to select browser option: Error: No option matches')
  })

  it('passes upload files to the page script and checks takeover before running it', async () => {
    const automation = new BrowserAutomation()
    const fake = contents(params => ({ result: { value: { method: params.arguments[1].value === 'paste' ? 'paste' : 'input', files: [{ name: 'a.png', type: 'image/png', size: 3 }] } } }))
    const snapshot = await automation.snapshot('tab-1', fake.contents)
    const files = [{ name: 'a.png', type: 'image/png', data: 'AQID' }]
    await expect(automation.upload('tab-1', fake.contents, snapshot.snapshotId, '@e1', files, 'paste')).resolves.toMatchObject({ method: 'paste' })
    const call = fake.commands.find(command => command.method === 'Runtime.callFunctionOn')!
    expect(call.params.arguments).toEqual([{ value: files }, { value: 'paste' }])

    const fresh = await automation.snapshot('tab-1', fake.contents)
    const before = fake.commands.length
    await expect(automation.upload('tab-1', fake.contents, fresh.snapshotId, '@e1', files, 'auto', () => { throw new Error('taken over') }))
      .rejects.toThrow('taken over')
    expect(fake.commands.slice(before).some(command => command.method === 'Runtime.callFunctionOn')).toBe(false)
  })

  it('waits for text and times out without matching', async () => {
    const automation = new BrowserAutomation()
    let text = ''
    const fake = contents(() => ({}), () => text)
    setTimeout(() => { text = 'Done' }, 250)
    await expect(automation.wait('tab-1', fake.contents, { text: 'Done', timeoutMs: 2000 })).resolves.toMatchObject({ matched: true })
    text = ''
    const timedOut = await automation.wait('tab-1', fake.contents, { text: 'Done', timeoutMs: 300 })
    expect(timedOut.matched).toBe(false)
    expect(timedOut.elapsedMs).toBeGreaterThanOrEqual(300)
  })
})
