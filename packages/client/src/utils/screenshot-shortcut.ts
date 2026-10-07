/** Convert physical keys to the portable subset accepted by the desktop shell. */
export function screenshotAccelerator(event: KeyboardEvent, platform: string): string | null {
  if (event.repeat || event.isComposing || (!event.ctrlKey && !event.altKey && !event.metaKey)) return null
  const code = event.code
  const navigation: Record<string, string> = {
    Space: 'Space', Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', Backspace: 'Backspace',
    Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', PrintScreen: 'PrintScreen',
  }
  const key = /^(Key[A-Z]|Digit[0-9])$/.test(code) ? code.replace(/^(Key|Digit)/, '')
    : /^F([1-9]|1[0-9]|2[0-4])$/.test(code) ? code : navigation[code]
  if (!key) return null
  return [event.ctrlKey ? 'Control' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : '',
    event.metaKey ? (platform === 'darwin' ? 'Command' : 'Super') : '', key].filter(Boolean).join('+')
}
