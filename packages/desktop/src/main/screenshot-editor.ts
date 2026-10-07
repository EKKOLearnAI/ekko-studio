/** Runs in the isolated screenshot renderer; keep its dependencies inside the function. */
export function installScreenshotEditor() {
  type Point = { x: number; y: number }
  type Rect = Point & { width: number; height: number }
  type Mark = { tool: string; color: string; width: number; start: Point; end: Point; points: Point[]; text?: string }
  type Payload = { requestId: string; bitmap?: { data: Uint8Array; width: number; height: number }; dataUrl?: string; labels: { hint: string; confirm: string; cancel: string; reset: string; tools?: Record<string, string> } }
  const api = (window as unknown as { screenshotOverlay: {
    submit: (value: { requestId: string; region: Rect; png: Uint8Array }) => void
    cancel: () => void
    select: () => void
    ready?: (requestId: string) => void
    onReset: (callback: () => void) => void
    onInit?: (callback: (payload: Payload) => void) => void
    onClear?: (callback: () => void) => void
  } }).screenshotOverlay
  const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
  const image = element<HTMLCanvasElement>('screen')
  const canvas = element<HTMLCanvasElement>('annotations')
  const context = canvas.getContext('2d')!
  const selection = element<HTMLDivElement>('selection')
  const toolbar = element<HTMLDivElement>('toolbar')
  const shade = element<HTMLDivElement>('shade')
  const hint = element<HTMLDivElement>('hint')
  const textEditor = element<HTMLTextAreaElement>('text-editor')
  const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value))
  let rect: Rect | null = null
  let tool = 'select'
  let color = '#ff453a'
  let width = 4
  let marks: Mark[] = []
  let undone: Mark[] = []
  let draft: Mark | null = null
  let textPoint: Point | null = null
  let drag: { start: Point; mode: string; edge: string; original: Rect | null } | null = null
  let requestId = ''
  let imageReady = false
  let exporting = false
  let paintFrame = 0
  let generation = 0

  function point(event: PointerEvent): Point {
    return { x: clamp(event.clientX, innerWidth), y: clamp(event.clientY, innerHeight) }
  }
  function inside(p: Point) {
    return !!rect && p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height
  }
  function normalized(start: Point, end: Point): Rect {
    return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }
  }
  function drawMark(ctx: CanvasRenderingContext2D, mark: Mark) {
    const shape = normalized(mark.start, mark.end)
    ctx.strokeStyle = mark.color
    ctx.fillStyle = mark.color
    ctx.lineWidth = mark.width
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    if (mark.tool === 'rectangle') ctx.strokeRect(shape.x, shape.y, shape.width, shape.height)
    else if (mark.tool === 'ellipse') {
      ctx.ellipse(shape.x + shape.width / 2, shape.y + shape.height / 2, shape.width / 2, shape.height / 2, 0, 0, Math.PI * 2)
      ctx.stroke()
    } else if (mark.tool === 'arrow') {
      const angle = Math.atan2(mark.end.y - mark.start.y, mark.end.x - mark.start.x)
      const head = Math.max(12, mark.width * 4)
      ctx.moveTo(mark.start.x, mark.start.y)
      ctx.lineTo(mark.end.x, mark.end.y)
      ctx.moveTo(mark.end.x - head * Math.cos(angle - Math.PI / 6), mark.end.y - head * Math.sin(angle - Math.PI / 6))
      ctx.lineTo(mark.end.x, mark.end.y)
      ctx.lineTo(mark.end.x - head * Math.cos(angle + Math.PI / 6), mark.end.y - head * Math.sin(angle + Math.PI / 6))
      ctx.stroke()
    } else if (mark.tool === 'pen') {
      ctx.moveTo(mark.points[0].x, mark.points[0].y)
      for (const p of mark.points.slice(1)) ctx.lineTo(p.x, p.y)
      if (mark.points.length === 1) ctx.lineTo(mark.points[0].x + 0.01, mark.points[0].y)
      ctx.stroke()
    } else if (mark.tool === 'text') {
      const fontSize = 16 + mark.width * 2
      ctx.font = `${fontSize}px system-ui, sans-serif`
      ctx.textBaseline = 'top'
      for (const [index, line] of (mark.text || '').split('\n').entries()) ctx.fillText(line, mark.start.x, mark.start.y + index * fontSize * 1.3)
    } else if (mark.tool === 'mosaic' && shape.width > 0 && shape.height > 0) {
      const sample = document.createElement('canvas')
      const block = Math.max(10, mark.width * 4)
      sample.width = Math.max(1, Math.ceil(shape.width / block))
      sample.height = Math.max(1, Math.ceil(shape.height / block))
      sample.getContext('2d')!.drawImage(image,
        shape.x * image.width / innerWidth, shape.y * image.height / innerHeight,
        shape.width * image.width / innerWidth, shape.height * image.height / innerHeight,
        0, 0, sample.width, sample.height)
      ctx.save()
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(sample, shape.x, shape.y, shape.width, shape.height)
      ctx.restore()
    }
  }
  function drawMarks(ctx: CanvasRenderingContext2D) {
    for (const mark of marks) drawMark(ctx, mark)
    if (draft) drawMark(ctx, draft)
  }
  function paint() {
    paintFrame = 0
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.clearRect(0, 0, canvas.width, canvas.height)
    if (!rect || !imageReady) return
    context.save()
    context.scale(canvas.width / innerWidth, canvas.height / innerHeight)
    context.beginPath()
    context.rect(rect.x, rect.y, rect.width, rect.height)
    context.clip()
    drawMarks(context)
    context.restore()
  }
  function requestPaint() { if (!paintFrame) paintFrame = requestAnimationFrame(paint) }
  function render() {
    const valid = rect && rect.width >= 2 && rect.height >= 2
    selection.hidden = !rect
    shade.hidden = !!rect
    hint.hidden = !!rect
    toolbar.hidden = !valid || !!drag || !!draft
    element<HTMLButtonElement>('undo').disabled = marks.length === 0
    element<HTMLButtonElement>('redo').disabled = undone.length === 0
    element<HTMLButtonElement>('confirm').disabled = exporting
    document.body.dataset.tool = tool
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tool]')) button.setAttribute('aria-pressed', String(button.dataset.tool === tool))
    if (rect) {
      Object.assign(selection.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` })
      const size = element<HTMLSpanElement>('size')
      size.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`
      size.style.bottom = rect.y < 32 ? 'auto' : 'calc(100% + 8px)'
      size.style.top = rect.y < 32 ? '8px' : 'auto'
      if (!toolbar.hidden) {
        toolbar.style.left = `${clamp(rect.x + rect.width - toolbar.offsetWidth, Math.max(0, innerWidth - toolbar.offsetWidth))}px`
        let top = rect.y + rect.height + 10
        if (top + toolbar.offsetHeight > innerHeight) top = Math.max(0, rect.y - toolbar.offsetHeight - 10)
        toolbar.style.top = `${top}px`
      }
    }
    requestPaint()
  }
  function commitText() {
    if (!textPoint) return
    const text = textEditor.value.trim()
    if (text) {
      marks.push({ tool: 'text', color, width, start: textPoint, end: textPoint, points: [], text })
      undone = []
    }
    textPoint = null
    textEditor.hidden = true
    textEditor.value = ''
    render()
  }
  function reset() {
    textPoint = null
    textEditor.hidden = true
    textEditor.value = ''
    rect = null
    drag = null
    draft = null
    marks = []
    undone = []
    tool = 'select'
    render()
  }
  function clear() {
    generation++
    imageReady = false
    requestId = ''
    exporting = false
    reset()
    image.width = 1
    image.height = 1
    canvas.width = 1
    canvas.height = 1
  }
  async function initialize(payload: Payload) {
    clear()
    const version = generation
    requestId = payload.requestId
    hint.textContent = payload.labels.hint
    for (const key of ['confirm', 'cancel', 'reset']) {
      const label = payload.labels[key as 'confirm' | 'cancel' | 'reset']
      const button = element<HTMLButtonElement>(key)
      button.title = label
      button.setAttribute('aria-label', label)
    }
    for (const [key, label] of Object.entries(payload.labels.tools || {})) {
      const button = document.querySelector<HTMLElement>(`[data-label="${key}"]`)
      if (button) { button.title = label; button.setAttribute('aria-label', label) }
      if (key === 'textPlaceholder') textEditor.placeholder = label
    }
    try {
      if (payload.bitmap) {
        const { width, height, data } = payload.bitmap
        image.width = width
        image.height = height
        image.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0)
      } else {
        const preview = new Image()
        preview.src = payload.dataUrl || ''
        await preview.decode()
        if (version !== generation) return
        image.width = preview.naturalWidth
        image.height = preview.naturalHeight
        image.getContext('2d')!.drawImage(preview, 0, 0)
      }
      if (version !== generation) return
      imageReady = true
      canvas.width = image.width
      canvas.height = image.height
      render()
      // Signal readiness once the pixels and overlay have reached a paint frame.
      requestAnimationFrame(() => { if (version === generation) api.ready?.(requestId) })
    } catch { if (version === generation) api.cancel() }
  }
  async function confirm() {
    if (!rect || !imageReady || drag || draft || exporting || rect.width < 2 || rect.height < 2) return
    commitText()
    const version = generation
    const region = { ...rect }
    const sx = image.width / innerWidth, sy = image.height / innerHeight
    const left = Math.floor(region.x * sx), top = Math.floor(region.y * sy)
    const right = Math.min(image.width, Math.ceil((region.x + region.width) * sx))
    const bottom = Math.min(image.height, Math.ceil((region.y + region.height) * sy))
    const output = document.createElement('canvas')
    output.width = right - left
    output.height = bottom - top
    const ctx = output.getContext('2d')!
    ctx.drawImage(image, left, top, output.width, output.height, 0, 0, output.width, output.height)
    ctx.setTransform(sx, 0, 0, sy, -left, -top)
    drawMarks(ctx)
    exporting = true
    render()
    try {
      const blob = await new Promise<Blob>((resolve, reject) => output.toBlob(value => value ? resolve(value) : reject(new Error('PNG export failed')), 'image/png'))
      const png = new Uint8Array(await blob.arrayBuffer())
      if (version === generation) api.submit({ requestId, region, png })
    } catch { if (version === generation) { exporting = false; render() } }
  }
  function undo() { commitText(); if (marks.length) undone.push(marks.pop()!); render() }
  function redo() { commitText(); if (undone.length) marks.push(undone.pop()!); render() }
  element<HTMLButtonElement>('reset').onclick = reset
  element<HTMLButtonElement>('cancel').onclick = () => api.cancel()
  element<HTMLButtonElement>('confirm').onclick = () => { void confirm() }
  element<HTMLButtonElement>('undo').onclick = undo
  element<HTMLButtonElement>('redo').onclick = redo
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
    button.onclick = () => { commitText(); tool = button.dataset.tool!; render() }
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-color]')) {
    button.onclick = () => {
      commitText()
      color = button.dataset.color!
      for (const swatch of document.querySelectorAll('[data-color]')) swatch.setAttribute('aria-pressed', String(swatch === button))
    }
  }
  element<HTMLSelectElement>('line-width').onchange = event => { commitText(); width = Number((event.target as HTMLSelectElement).value) }
  textEditor.onblur = commitText
  textEditor.onkeydown = event => {
    event.stopPropagation()
    if (event.key === 'Escape') { textPoint = null; textEditor.hidden = true; textEditor.value = ''; render() }
    else if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); commitText() }
  }
  api.onReset(reset)
  api.onClear?.(clear)
  api.onInit?.(payload => { void initialize(payload) })
  document.addEventListener('contextmenu', event => { event.preventDefault(); api.cancel() })
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return }
    if (event.key === 'Escape') { event.preventDefault(); api.cancel() }
    if (event.key === 'Enter') { event.preventDefault(); void confirm() }
  })
  document.addEventListener('pointerdown', event => {
    const target = event.target as HTMLElement
    if (!imageReady || exporting || event.button !== 0 || target.closest('#toolbar, #text-editor')) return
    commitText()
    const start = point(event), edge = target.dataset.edge || ''
    if (rect && tool !== 'select') {
      if (!inside(start)) return
      if (tool === 'text') {
        event.preventDefault()
        textPoint = start
        textEditor.hidden = false
        textEditor.style.left = `${start.x}px`
        textEditor.style.top = `${start.y}px`
        textEditor.style.width = `${Math.max(40, Math.min(260, rect.x + rect.width - start.x))}px`
        textEditor.style.color = color
        textEditor.style.fontSize = `${16 + width * 2}px`
        textEditor.focus()
        return
      }
      draft = { tool, color, width, start, end: start, points: [start] }
    } else {
      const mode = edge ? 'resize' : target.closest('#selection') && rect ? 'move' : 'draw'
      drag = { start, mode, edge, original: rect ? { ...rect } : null }
      api.select()
      if (mode === 'draw') { rect = { ...start, width: 0, height: 0 }; marks = []; undone = [] }
    }
    document.body.setPointerCapture(event.pointerId)
    render()
  })
  function move(event: PointerEvent) {
    const current = point(event)
    if (draft) {
      draft.end = { x: Math.max(rect!.x, Math.min(rect!.x + rect!.width, current.x)), y: Math.max(rect!.y, Math.min(rect!.y + rect!.height, current.y)) }
      if (draft.tool === 'pen') draft.points.push(draft.end)
      requestPaint()
      return
    }
    if (!drag) return
    const dx = current.x - drag.start.x, dy = current.y - drag.start.y, original = drag.original!
    if (drag.mode === 'draw') rect = normalized(drag.start, current)
    else if (drag.mode === 'move') rect = { ...original, x: clamp(original.x + dx, innerWidth - original.width), y: clamp(original.y + dy, innerHeight - original.height) }
    else {
      let left = original.x, right = left + original.width, top = original.y, bottom = top + original.height
      if (drag.edge.includes('w')) left = current.x
      if (drag.edge.includes('e')) right = current.x
      if (drag.edge.includes('n')) top = current.y
      if (drag.edge.includes('s')) bottom = current.y
      rect = normalized({ x: left, y: top }, { x: right, y: bottom })
    }
    render()
  }
  document.addEventListener('pointermove', move)
  document.addEventListener('pointerup', event => {
    if (!drag && !draft) return
    move(event)
    if (draft) {
      if (draft.tool === 'pen' || Math.hypot(draft.end.x - draft.start.x, draft.end.y - draft.start.y) >= 2) { marks.push(draft); undone = [] }
      draft = null
    }
    drag = null
    if (rect && (rect.width < 2 || rect.height < 2)) rect = null
    render()
  })
  document.addEventListener('pointercancel', () => { draft = null; drag = null; render() })
  const initial = (window as unknown as { __screenshotInitial?: Payload }).__screenshotInitial
  if (initial) void initialize(initial)
}
