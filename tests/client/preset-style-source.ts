import { readFileSync } from 'node:fs'

/** Existing source-level layout checks assert preset geometry. Resolve only the
 * optional theme overrides here; live overrides are exercised in theme.spec.ts. */
export function readPresetStyleSource(path: string, encoding: 'utf8' = 'utf8'): string {
  let source = readFileSync(path, encoding)
  source = source.replace(/calc\((\d+px) \* var\(--spacing-scale, 1\)\)/g, '$1')
    .replace(/calc\(var\(--font-size-base, 14px\) \* (\d+) \/ 14\)/g, '$1px')
  const optionalToken = /var\(--(?:theme-[a-zA-Z]+-(?:bg|filter|radius|border|shadow)|message-theme-(?:bg|filter)|radius-(?:component|sm|md|lg)|border-width|font-code|line-height),\s*/g
  let previous: string
  do {
    previous = source
    for (const match of [...source.matchAll(optionalToken)].reverse()) {
      const start = match.index! + match[0].length
      let depth = 1, end = start
      while (end < source.length && depth > 0) {
        if (source[end] === '(') depth += 1
        if (source[end] === ')') depth -= 1
        end += 1
      }
      if (depth === 0) source = source.slice(0, match.index) + source.slice(start, end - 1) + source.slice(end)
    }
  } while (previous !== source)
  return source
}
