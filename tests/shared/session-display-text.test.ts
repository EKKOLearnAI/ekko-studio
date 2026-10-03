import { describe, expect, it } from 'vitest'
import { sessionDisplayText, sessionDisplayPreview } from '../../packages/server/src/modules/studio/contracts/session-display-text'
describe('session content display extraction', () => {
  it('extracts text before truncating serialized multimodal blocks', () => {
    const body = JSON.stringify([{ type: 'image', name: 'photo.png', path: '/private/photo.png' }, { type: 'text', text: 'What is in this photo?\nExplain it.' }])
    expect(sessionDisplayText(body)).toBe('What is in this photo?\nExplain it.')
    expect(sessionDisplayPreview(body, 12)).toBe('What is in t')
  })
  it('uses names for attachment-only content, never local paths', () => {
    expect(sessionDisplayText(JSON.stringify([{ type: 'image', name: 'photo.png', path: '/private/photo.png' }]))).toBe('photo.png')
  })
  it('preserves normal JSON examples and literal tool-like text', () => {
    for (const text of ['[{"a":1}]', '[{"type":"example","text":"code"}]', '[invalid', '<invoke name="Bash">example</invoke>', 'Normal title']) expect(sessionDisplayText(text)).toBe(text)
  })
})
