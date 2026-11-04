import { describe, expect, it } from 'vitest'
import { blocksQueuePreview, parseContentBlocks, parseMessageReference } from '../../packages/client/src/utils/content-blocks'

describe('parseContentBlocks', () => {
  it('returns null for plain text content', () => {
    expect(parseContentBlocks('做测试')).toBeNull()
    expect(parseContentBlocks('')).toBeNull()
    expect(parseContentBlocks('{"type":"text"}')).toBeNull()
  })

  it('parses a serialized ContentBlock array', () => {
    const blocks = parseContentBlocks('[{"type":"text","text":"做测试"},{"type":"image","name":"shot.png","path":"/data/shot.png"}]')
    expect(blocks).not.toBeNull()
    expect(blocks).toHaveLength(2)
    expect(blocks![0]).toMatchObject({ type: 'text', text: '做测试' })
  })

  it('parses the legacy Python str(list) representation', () => {
    const blocks = parseContentBlocks("[{'type': 'text', 'text': '旧格式'}, {'type': 'image', 'name': 'a.png', 'path': '/a.png'}]")
    expect(blocks).not.toBeNull()
    expect(blocks![0]).toMatchObject({ type: 'text', text: '旧格式' })
  })

  it('returns null for malformed JSON that is not a block array', () => {
    expect(parseContentBlocks('[{"no_type": true}]')).toBeNull()
    expect(parseContentBlocks('[1, 2, 3]')).toBeNull()
  })
})

describe('blocksQueuePreview', () => {
  it('projects a text-plus-image message to its text with a file-name marker', () => {
    const blocks = parseContentBlocks('[{"type":"text","text":"做测试"},{"type":"image","name":"shot.png","path":"/p"}]')!
    expect(blocksQueuePreview(blocks)).toBe('做测试 [shot.png]')
  })

  it('appends one marker per attachment', () => {
    const blocks = parseContentBlocks(
      '[{"type":"text","text":"看下"},{"type":"image","name":"1.png","path":"/1"},{"type":"image","name":"2.png","path":"/2"},{"type":"file","name":"报告.pdf","path":"/f"}]',
    )!
    expect(blocksQueuePreview(blocks)).toBe('看下 [1.png] [2.png] [报告.pdf]')
  })

  it('falls back to the marker list for text-less attachment messages', () => {
    const blocks = parseContentBlocks('[{"type":"image","name":"pasted.png","path":"/p"}]')!
    expect(blocksQueuePreview(blocks)).toBe('[pasted.png]')
  })

  it('uses the block type when the attachment has no name', () => {
    const blocks = parseContentBlocks('[{"type":"file"}]')!
    expect(blocksQueuePreview(blocks)).toBe('[file]')
  })

  it('truncates the text but keeps the attachment markers intact', () => {
    const long = '很长的消息'.repeat(20)
    const blocks = parseContentBlocks(`[{"type":"text","text":"${long}"},{"type":"image","name":"shot.png","path":"/p"}]`)!
    const preview = blocksQueuePreview(blocks)
    expect(preview.endsWith('[shot.png]')).toBe(true)
    expect(preview.length).toBeLessThan(long.length)
  })

  it('hides browser-selection context text from the preview', () => {
    const blocks = parseContentBlocks(
      '[{"type":"image","name":"selection.png","path":"/s"},{"type":"text","text":"<browser_selection_context format=\\"json\\">meta</browser_selection_context>"}]',
    )!
    expect(blocksQueuePreview(blocks)).toBe('[selection.png]')
  })

  it('never returns an empty preview for non-empty block input', () => {
    const blocks = parseContentBlocks('[{"type":"text","text":"   "}]')!
    expect(blocksQueuePreview(blocks)).toBe('[…]')
  })

  it('collapses a quoted message to its reply text', () => {
    const blocks = parseContentBlocks('[{"type":"text","text":"<quoted_message>\\n被引用的原文\\n</quoted_message>\\n\\n新的回复"},{"type":"image","name":"a.png","path":"/a"}]')!
    expect(blocksQueuePreview(blocks)).toBe('新的回复 [a.png]')
  })

  it('falls back to the quoted content when the reply is empty', () => {
    const blocks = parseContentBlocks('[{"type":"text","text":"<quoted_message>\\n被引用的原文\\n</quoted_message>"},{"type":"image","name":"a.png","path":"/a"}]')!
    expect(blocksQueuePreview(blocks)).toBe('被引用的原文 [a.png]')
  })

  it('keeps a long quote from hiding the reply via truncation', () => {
    const longQuote = '很长的引用内容'.repeat(30)
    const blocks = parseContentBlocks(`[{"type":"text","text":"<quoted_message>\\n${longQuote}\\n</quoted_message>\\n\\n简短回复"},{"type":"image","name":"a.png","path":"/a"}]`)!
    expect(blocksQueuePreview(blocks)).toBe('简短回复 [a.png]')
  })

  it('skips a single internal video representative frame', () => {
    const blocks = parseContentBlocks('[{"type":"text","text":"看视频"},{"type":"file","name":"clip.mp4","path":"/v","media_type":"video/mp4"},{"type":"image","name":"frame-1.jpg","path":"/f1","video_frame":true}]')!
    expect(blocksQueuePreview(blocks)).toBe('看视频 [clip.mp4]')
  })

  it('skips multiple internal video representative frames', () => {
    const blocks = parseContentBlocks('[{"type":"text","text":"看视频"},{"type":"file","name":"clip.mp4","path":"/v","media_type":"video/mp4"},{"type":"image","name":"frame-1.jpg","path":"/f1","video_frame":true},{"type":"image","name":"frame-2.jpg","path":"/f2","video_frame":true}]')!
    expect(blocksQueuePreview(blocks)).toBe('看视频 [clip.mp4]')
  })
})

describe('parseMessageReference', () => {
  it('extracts quoted content and reply', () => {
    expect(parseMessageReference('<quoted_message>\n原文\n</quoted_message>\n\n回复')).toEqual({ content: '原文', reply: '回复' })
  })

  it('parses a wrapper with a sender attribute', () => {
    expect(parseMessageReference('<quoted_message sender="张三">\n原文\n</quoted_message>\n\n回复')).toEqual({ content: '原文', reply: '回复' })
  })

  it('returns null for content without a quote wrapper', () => {
    expect(parseMessageReference('普通消息')).toBeNull()
  })
})
