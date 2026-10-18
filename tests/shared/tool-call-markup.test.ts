import { describe, expect, it } from 'vitest'
import MarkdownIt from 'markdown-it'
import { filterToolCallMarkup, flushToolCallMarkup, stripToolCallMarkup } from '../../packages/shared/tool-call-markup'

const protocol = '<tool_call><invoke name="read_file"><parameter name="path">demo.txt</parameter></invoke></tool_call>'

function expectAllChunkBoundaries(input: string, expected: string) {
  expect(stripToolCallMarkup(input)).toBe(expected)
  for (let split = 0; split <= input.length; split++) {
    const state = {}
    expect(filterToolCallMarkup(state, input.slice(0, split))
      + filterToolCallMarkup(state, input.slice(split))
      + flushToolCallMarkup(state)).toBe(expected)
  }
  const state = {}
  expect([...input].map(char => filterToolCallMarkup(state, char)).join('')
    + flushToolCallMarkup(state)).toBe(expected)
}

describe('text-channel protocol filtering', () => {
  it.each([
    '- ~~~xml\n  <tool_call>example</tool_call>\n  ~~~',
    '- ```xml\n  <!-- literal ``` -->\n  <tool_call>example</tool_call>\n  ```',
    '10. ~~~xml\n    <tool_call>example</tool_call>\n    ~~~',
    '- > ~~~xml\n  > <tool_call>example</tool_call>\n  > ~~~',
    '> - ```xml\n>   <!-- literal ``` -->\n>   <tool_call>example</tool_call>\n>   ```',
    '   - ~~~xml\n     <tool_call>example</tool_call>\n        ~~~',
    '- - ~~~xml\n    <tool_call>example</tool_call>\n    ~~~',
    '> ```xml\n> <tool_call>example</tool_call>\n> ```',
  ])('preserves container fences across every stream split: %s', example => {
    expect(new MarkdownIt().render(example)).toContain('&lt;tool_call&gt;example&lt;/tool_call&gt;')
    expectAllChunkBoundaries(`${example}\n\n${protocol}\nAnswer`, `${example}\n\n\nAnswer`)
  })

  it.each(['- ~~~xml\n  literal', '> ```xml\n> literal'])('ends an unclosed fence when leaving its container: %s', example => {
    expectAllChunkBoundaries(`${example}\n\n${protocol}\nAnswer`, `${example}\n\n\nAnswer`)
  })

  it.each([
    '```inline```',
    '```inline ` literal```',
    '````inline````',
  ])('does not mistake line-start inline code for a fence: %s', example => {
    expectAllChunkBoundaries(`${example}\n${protocol}\nAnswer`, `${example}\n\nAnswer`)
  })

  it.each([
    '    <parameter name="path">literal-example</parameter>',
    '\t<parameter name="path">literal-example</parameter>',
    'Intro\n\n    <parameter name="path">literal-example</parameter>',
    '    code\n    <parameter name="path">literal-example</parameter>',
  ])('preserves parameters in indented code: %s', example => {
    expectAllChunkBoundaries(`${example}\n\nAnswer\n${protocol}`, `${example}\n\nAnswer\n`)
  })

  it.each(['', ' ', '  ', '   ', '    ', '\t'])('keeps non-code protocol indentation policy: %j', indent => {
    expectAllChunkBoundaries(
      `Before\n${indent}<parameter name = "path">private-path</parameter>\nAnswer`,
      `Before\n${indent}\nAnswer`,
    )
  })

  it.each([
    '<parameter name="path">private-path</parameter>',
    '<parameter\tname \t= "path">private-path</parameter>',
    '<invoke name = "read_file"><parameter name="path">private-path</parameter></invoke>',
    '<invoke \t name\n = "read_file"><parameter name="path">private-path</parameter></invoke>',
  ])('filters structural line-leading protocol across every split: %s', markup => {
    expectAllChunkBoundaries(`Before\n  ${markup}\nAnswer`, 'Before\n  \nAnswer')
  })

  it.each([
    '```text\nAn embedded ``` is literal inside this fence.\n<tool_call>example</tool_call>\n```',
    '~~~text\nAn embedded ~~~ is literal inside this fence.\n<parameter name="path">example</parameter>\n~~~',
    '````xml\n```\n<invoke name = "read_file">example</invoke>\n````',
    '```xml\n```not-a-closing-fence\n<tool_call>example</tool_call>\n```',
    '```xml\n``` \t nope\n<tool_call>example</tool_call>\n```',
    '```xml\n~~~\n<tool_call>example</tool_call>\n```',
    '```xml\n    ```\n<tool_call>example</tool_call>\n```',
  ])('keeps fenced examples with literal fence-like text: %s', example => {
    expectAllChunkBoundaries(`${example}\n${protocol}\nAnswer`, `${example}\n\nAnswer`)
  })

  it.each([
    ['```xml', '````'],
    ['~~~xml', '~~~~~'],
    ['   ```xml', '  ```` \t'],
    ['```xml\r', '````\r'],
  ])('recognizes a longer closing fence after %s', (opening, closing) => {
    const example = `${opening}\n<parameter name="path">example</parameter>\n${closing}\n`
    expectAllChunkBoundaries(`${example}${protocol}\nAnswer`, `${example}\nAnswer`)
  })

  it.each([
    '`<parameter name="path">example</parameter>`',
    '``inline ` backtick\n<invoke name = "read_file">example</invoke>\n``',
    '`inline ``` backticks\n<tool_call>example</tool_call>\n`',
    'Explain <parameter name="path">example</parameter> here.',
    '<invoke names="ordinary">keep</invoke>',
    '<parameter namespace="ordinary">keep</parameter>',
  ])('preserves inline code, discussion and non-protocol attributes: %s', example => {
    expectAllChunkBoundaries(`${example}\n${protocol}\nAnswer`, `${example}\n\nAnswer`)
  })

  it('does not treat escaped backticks or prose tildes as code openers', () => {
    expectAllChunkBoundaries('Escaped \\`\n' + protocol, 'Escaped \\`\n')
    expectAllChunkBoundaries(`Prose ~~~ text\n${protocol}`, 'Prose ~~~ text\n')
  })

  it('removes protocol blocks while retaining the answer', () => {
    expect(stripToolCallMarkup(`Before\n${protocol}\nAfter`)).toBe('Before\n\nAfter')
  })

  it('handles every possible two-chunk split', () => {
    for (let split = 0; split <= protocol.length; split++) {
      const state = {}
      const text = filterToolCallMarkup(state, protocol.slice(0, split))
        + filterToolCallMarkup(state, protocol.slice(split) + '\nDone')
        + flushToolCallMarkup(state)
      expect(text).toBe('\nDone')
    }
  })

  it('keeps code examples, inline discussion and ordinary XML', () => {
    const text = `Explain <tool_call> here.\n\`${protocol}\`\n\`\`\`xml\n${protocol}\n\`\`\`\n<article>Hello</article>`
    expect(stripToolCallMarkup(text)).toBe(text)
  })

  it('bounds discarded argument memory and drops unfinished protocol without executing it', () => {
    const state = {}
    filterToolCallMarkup(state, '<tool_call>' + 'x'.repeat(500_000))
    expect(JSON.stringify(state).length).toBeLessThan(200)
    expect(flushToolCallMarkup(state)).toBe('')
    expect(stripToolCallMarkup('A comparison\n<')).toBe('A comparison\n<')
  })

  it('handles the function-call wrappers and DSML shape', () => {
    for (const [open, close] of [
      ['<function_calls>', '</function_calls>'],
      ['<｜DSML｜function_calls>', '</｜DSML｜function_calls>'],
    ]) expect(stripToolCallMarkup(`${open}<invoke name="test">payload</invoke>${close}\nDone`)).toBe('\nDone')
  })

  it('drops orphan protocol closing tags but keeps documented closers in code', () => {
    expect(stripToolCallMarkup('</parameter>\n</invoke>\nAnswer')).toBe('\n\nAnswer')
    expect(stripToolCallMarkup('`</parameter>`')).toBe('`</parameter>`')
    expect(stripToolCallMarkup('~~~xml\n<tool_call>example</tool_call>\n~~~')).toContain('example')
  })
})
