import { describe, expect, it } from 'vitest'
import { pushPreview } from '../../packages/server/src/modules/studio/services/notifications/push-preview'

describe('push plain-text previews', () => {
  it('renders Markdown links, formatting, images and blocks as readable text', () => {
    const source = '# 结果\n\n**完成** [查看](https://example.com/secret) ![截图](image.png)\n\n- 一项\n- 二项\n\n```ts\nconst n = 1\n```'
    expect(pushPreview(source, 160, true)).toBe('结果 完成 查看 截图 一项 二项 const n = 1')
  })
  it('removes HTML markup, comments, scripts and styles from previews', () => {
    expect(pushPreview('<div>完成</div>\n\n<script>secret()</script><!-- hidden --><style>secret</style>', 160, true)).toBe('完成')
  })
  it('normalizes titles without interpreting their names as Markdown', () => {
    expect(pushPreview('  # A_B \n C  ', 40)).toBe('# A_B C')
  })
  it.each(['👨‍👩‍👧‍👦', '🇨🇳', '👍🏽', 'e\u0301'])('clips complete visible characters: %s', value => {
    expect(pushPreview(value.repeat(41), 40)).toBe(value.repeat(40))
    expect(pushPreview('**' + value.repeat(161) + '**', 160, true)).toBe(value.repeat(160))
  })
  it('does not emit arbitrary objects or only whitespace', () => {
    expect(pushPreview({ output: 'hidden' }, 160, true)).toBe('')
    expect(pushPreview(' \r\n\u0000 ', 160, true)).toBe('')
  })
})
