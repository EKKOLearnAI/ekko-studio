import { parse as parseToml } from 'smol-toml'

interface TomlArrayScanState {
  quote: '"' | "'" | null
  multiline: boolean
}

function scanTomlArrayBrackets(line: string, state: TomlArrayScanState): number {
  let delta = 0
  let escaped = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (state.quote) {
      if (state.multiline) {
        if (state.quote === '"' && char === '\\') {
          escaped = !escaped
          continue
        }
        if (char === state.quote && !escaped) {
          let quoteCount = 1
          while (line[index + quoteCount] === state.quote) quoteCount += 1
          if (quoteCount >= 3) {
            state.quote = null
            state.multiline = false
            index += quoteCount - 1
          }
        }
        escaped = false
        continue
      }
      if (state.quote === '"' && char === '\\' && !escaped) {
        escaped = true
        continue
      }
      if (char === state.quote && !escaped) state.quote = null
      escaped = false
      continue
    }
    if (char === '#') break
    if (char === '"' || char === "'") {
      state.quote = char
      state.multiline = line.slice(index, index + 3) === char.repeat(3)
      if (state.multiline) index += 2
      continue
    }
    if (char === '[') delta += 1
    else if (char === ']') delta -= 1
  }
  return delta
}

const assignmentPattern = /^\s*((?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*'))*)\s*=/

/** Read the whole value before deciding whether to inherit or discard a setting. */
export function readTomlAssignment(lines: string[], startIndex: number): {
  key: string[]
  lines: string[]
  endIndex: number
} | null {
  const line = lines[startIndex]
  const match = line.match(assignmentPattern)
  if (!match) return null

  // Let the TOML parser normalize quoted/escaped keys without touching value formatting.
  const key: string[] = []
  let keyTable: unknown = parseToml(`${match[1]} = 0`)
  while (keyTable && typeof keyTable === 'object') {
    const [name, value] = Object.entries(keyTable)[0]
    key.push(name)
    keyTable = value
  }

  const entryLines = [line]
  const scanState: TomlArrayScanState = { quote: null, multiline: false }
  let bracketDepth = scanTomlArrayBrackets(line.slice(match[0].length), scanState)
  let endIndex = startIndex
  while ((bracketDepth > 0 || scanState.multiline) && endIndex + 1 < lines.length) {
    endIndex += 1
    entryLines.push(lines[endIndex])
    bracketDepth += scanTomlArrayBrackets(lines[endIndex], scanState)
  }
  return { key, lines: entryLines, endIndex }
}
