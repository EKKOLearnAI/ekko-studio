import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { getCodingAgentGlobalHome } from './coding-agent-global-home'

async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path) } catch (error: any) {
    if (error.code !== 'ENOENT') throw error
    const parent = dirname(path)
    return parent === path ? path : join(await canonicalPath(parent), relative(parent, path))
  }
}

function within(path: string, root: string) {
  const suffix = relative(root, path)
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
}

/** Shared skills are readable by every runtime, but managed outside agent pages. */
export async function isSharedCodingAgentSkill(path: string): Promise<boolean> {
  const root = resolve(getCodingAgentGlobalHome(), '.agents', 'skills')
  const target = resolve(path)
  if (within(target, root)) return true
  return within(await canonicalPath(target), await canonicalPath(root))
}

export async function assertCodingAgentSkillWritable(path: string): Promise<void> {
  if (await isSharedCodingAgentSkill(path)) {
    throw Object.assign(new Error('Shared .agents/skills are read-only in Coding Agent pages'), { status: 403 })
  }
}
