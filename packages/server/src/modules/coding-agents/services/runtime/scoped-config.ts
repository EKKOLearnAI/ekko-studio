import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface ScopedRuntimeInput {
  rootDir: string
  model: string
  baseUrl: string
  token: string
  contextWindow: number
  outputLimit: number
}

export interface ScopedRuntimeConfig {
  args: string[]
  env: Record<string, string>
  files: Array<{ key: string; path: string; absolutePath: string }>
}

/** Write private per-session files; upstream credentials stay in the proxy. */
export async function createScopedRuntimeConfig(input: ScopedRuntimeInput) {
  const files: ScopedRuntimeConfig['files'] = []
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
  const write = async (key: string, path: string, content: string) => {
    const absolutePath = join(input.rootDir, path)
    await writeFile(absolutePath, content, { encoding: 'utf8', mode: 0o600 })
    files.push({ key, path, absolutePath })
  }
  await mkdir(input.rootDir, { recursive: true, mode: 0o700 })
  return { ...input, files, json, write,
    contextWindow: Math.max(1, Math.floor(input.contextWindow || 128000)),
    outputLimit: Math.max(1, Math.floor(input.outputLimit || 8192)),
  }
}
