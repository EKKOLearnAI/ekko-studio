import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => {
  const agentCmd = 'C:\\Users\\tester\\AppData\\Local\\cursor-agent\\agent.CMD'
  const calls: Array<{ command: string; args: string[]; options: any }> = []
  const execFile = vi.fn()
  ;(execFile as any)[Symbol.for('nodejs.util.promisify.custom')] = async (command: string, args: string[], options: any) => {
    calls.push({ command, args, options })
    if (command === (process.env.comspec || 'cmd.exe')) {
      return { stdout: '2026.10.22-27dcf5f\n', stderr: '' }
    }
    throw new Error(`unexpected command: ${command}`)
  }
  return { agentCmd, calls, execFile }
})

vi.mock('child_process', () => ({
  execFile: state.execFile,
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    // 模拟 Cursor CLI 安装目录中的 agent.cmd；其他路径沿用真实文件系统。
    existsSync: (path: string) => path.toLowerCase() === state.agentCmd.toLowerCase() || actual.existsSync(path),
  }
})

import { getCodingAgentDefinition, getCodingAgentStatus } from '../../packages/server/src/bootstrap/coding-agents'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const originalPathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path')
const originalPath = originalPathKey ? process.env[originalPathKey] : undefined
const originalLocalAppData = process.env.LOCALAPPDATA
const originalUserProfile = process.env.USERPROFILE

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform })
}

function deletePathKeys() {
  for (const key of Object.keys(process.env).filter(item => item.toLowerCase() === 'path')) {
    delete process.env[key]
  }
}

beforeEach(() => {
  state.calls.length = 0
  setPlatform('win32')
  deletePathKeys()
  // 模拟 Windows 继承的 Path 键名，且是安装前的旧 PATH：不含 Cursor CLI 安装目录。
  process.env.Path = 'C:\\Windows'
  process.env.LOCALAPPDATA = 'C:\\Users\\tester\\AppData\\Local'
  process.env.USERPROFILE = 'C:\\Users\\tester'
})

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
  deletePathKeys()
  if (typeof originalPathKey !== 'undefined' && typeof originalPath !== 'undefined') {
    process.env[originalPathKey] = originalPath
  }
  if (typeof originalLocalAppData === 'undefined') delete process.env.LOCALAPPDATA
  else process.env.LOCALAPPDATA = originalLocalAppData
  if (typeof originalUserProfile === 'undefined') delete process.env.USERPROFILE
  else process.env.USERPROFILE = originalUserProfile
})

describe('Cursor CLI 安装目录检测', () => {
  it('PATH 未刷新时仍能从安装目录发现 agent.cmd', async () => {
    const status = await getCodingAgentStatus(getCodingAgentDefinition('cursor')!)

    expect(status.installed).toBe(true)
    expect(status.version).toBe('2026.10.22-27dcf5f')
    expect(status.path.toLowerCase()).toBe(state.agentCmd.toLowerCase())
    expect(state.calls.some(call => call.command === (process.env.comspec || 'cmd.exe'))).toBe(true)
  })
})
