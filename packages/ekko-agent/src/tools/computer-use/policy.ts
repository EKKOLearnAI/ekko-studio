// Keep configuration, browser-profile grants, installation and process termination
// outside the model-facing surface. New driver tools require an explicit review here.
export const COMPUTER_USE_READ_TOOLS = new Set([
  'list_apps', 'list_windows', 'get_window_state', 'get_desktop_state',
  'get_accessibility_tree', 'get_screen_size', 'get_cursor_position',
  'verify_state', 'zoom', 'check_permissions', 'health_report',
])

export const COMPUTER_USE_INPUT_TOOLS = new Set([
  'click', 'double_click', 'right_click', 'drag', 'scroll', 'type_text',
  'press_key', 'hotkey', 'set_value', 'invoke_menu', 'launch_app',
  'bring_to_front', 'set_window_frame', 'move_cursor',
])

export function computerUseApproval(input: Record<string, unknown>) {
  if (input.action !== 'call' || COMPUTER_USE_READ_TOOLS.has(String(input.tool))) return undefined
  const args = record(input.arguments)
  const visible = args.delivery_mode === 'foreground' || args.scope === 'desktop'
    || record(args.target).kind === 'desktop' || input.tool === 'bring_to_front'
    || input.tool === 'set_window_frame'
  const mode = visible ? 'foreground' : 'background'
  return {
    key: `computer_use:${String(input.tool)}:${mode}`,
    command: JSON.stringify({ tool: input.tool, arguments: args }).slice(0, 4000),
    description: `controls a desktop application using ${String(input.tool)} (${mode})`,
  }
}

export function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}
