const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6XcAAAAASUVORK5CYII='
const operations = ['list_apps', 'list_windows', 'get_window_state', 'get_desktop_state', 'click', 'type_text', 'check_permissions', 'set_config', 'kill_app']

export class FakeCuaSdkDriver {
  capture = 0
  closed = false
  destroyed = false
  calls: Array<{ name: string; args: any; signal: AbortSignal }> = []

  constructor(readonly instanceId: number) {}

  async listToolsJson({ signal }: { signal: AbortSignal }) {
    signal.throwIfAborted()
    return JSON.stringify({ tools: operations.map(name => ({
      name, description: `Fixture ${name}`,
      inputSchema: {
        type: 'object',
        properties: {
          pid: { type: 'integer' }, window_id: { type: 'integer' },
          session: { type: 'string', description: 'Repeat this session label on every call.' },
          delivery_mode: { type: 'string' },
          ...(name === 'get_window_state' ? { screenshot_out_file: { type: 'string' }, debug_image_out: { type: 'string' }, _internal: { type: 'boolean' } } : {}),
          ...(name === 'check_permissions' ? { prompt: { type: 'boolean' }, probe_direct_capture: { type: 'boolean' } } : {}),
        },
        ...(name === 'get_window_state' ? { required: ['pid', 'window_id'] } : {}),
      },
    })) })
  }

  async callTool(name: string, argumentsJson: string, { signal }: { signal: AbortSignal }): Promise<{ rawJson: string }> {
    signal.throwIfAborted()
    if (this.closed) throw new Error('Fixture runtime has shut down')
    const args = JSON.parse(argumentsJson)
    this.calls.push({ name, args, signal })
    if (args.text === '__hang__') return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    const value = { name, args, driverId: this.instanceId, capture: this.capture }
    if (name === 'list_windows') {
      Object.assign(value, { windows: [{ pid: 123, window_id: 456, title: 'Fixture window', bounds: { x: 0, y: 0, width: 1600, height: 900 } }] })
      return { rawJson: JSON.stringify({ content: [{ type: 'text', text: 'Found 1 window(s).' }], structuredContent: value }) }
    }
    if (name === 'check_permissions') Object.assign(value, { accessibility: true, screen_recording: true })
    if (name === 'get_window_state' || name === 'get_desktop_state') {
      this.capture++
      Object.assign(value, { capture: this.capture, snapshot_id: `s${this.capture}`, screenshot_scale: 0.5, window_bounds: { x: 0, y: 0, width: 1600, height: 900 }, elements: [{ element_token: `s${this.capture}:1`, role: 'button', label: 'Fixture' }] })
      return { rawJson: JSON.stringify({ content: [
        { type: 'text', text: `snapshot_id=s${this.capture} elements=1` },
        ...(args.include_screenshot === false ? [] : [{ type: 'image', mimeType: 'image/png', data: png }]),
      ], structuredContent: value }) }
    }
    if (name === 'click' && args.element_token !== `s${this.capture}:1`) {
      return { rawJson: JSON.stringify({ isError: true, content: [{ type: 'text', text: 'stale snapshot; capture again' }], structuredContent: { ok: false } }) }
    }
    if (name === 'type_text') {
      Object.assign(value, { effect: 'unverifiable', route: 'synthetic_events', delivery: { mode: args.delivery_mode }, escalation: { target: 'foreground', reason: 'effect_unconfirmed' } })
      return { rawJson: JSON.stringify({ content: [{ type: 'text', text: 'Input dispatched; verify the result.' }], structuredContent: value }) }
    }
    return { rawJson: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }) }
  }

  async shutdown() { this.closed = true }
  uniffiDestroy() { this.destroyed = true }
}
