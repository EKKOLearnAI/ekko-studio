import { existsSync, readFileSync, statSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareZcodePrompt } from '../../packages/server/src/modules/coding-agents/services/native/zcode-prompt'

const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const pending: Array<() => void> = []
afterEach(() => {
  Object.defineProperty(process, 'platform', descriptor)
  for (const cleanup of pending.splice(0)) cleanup()
})

describe('ZCode argv prompt transport', () => {
  it.each(['win32', 'darwin', 'linux'])('stages large Unicode input without losing its tail on %s', platform => {
    Object.defineProperty(process, 'platform', { value: platform })
    const text = '完整 instructions\r\n"%PATH%" & 中文😀 '.repeat(8000) + '\nFINAL_SENTINEL'
    const prepared = prepareZcodePrompt('zcode.cmd', ['--attach', '/image.png'], text)
    pending.push(prepared.cleanup)
    expect(prepared.args).toContain('/image.png')
    expect(prepared.args.join(' ').length).toBeLessThan(7000)
    expect(prepared.args.join(' ')).not.toContain('FINAL_SENTINEL')
    const attachmentIndex = prepared.args.lastIndexOf('--attach')
    const path = prepared.args[attachmentIndex + 1]
    expect(readFileSync(path, 'utf8')).toBe(text)
    expect(prepared.args.at(-1)).toContain('Read the entire file to EOF')
    if (descriptor.value !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    prepared.cleanup()
    expect(existsSync(path)).toBe(false)
    prepared.cleanup()
  })
  it('stages even a short multiline prompt on Windows to avoid cmd.exe newline parsing', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const prepared = prepareZcodePrompt('zcode.cmd', [], 'first\nsecond')
    pending.push(prepared.cleanup)
    expect(prepared.args).toContain('--attach')
    expect(readFileSync(prepared.args[1], 'utf8')).toBe('first\nsecond')
    expect(prepared.args.at(-1)).not.toMatch(/[\r\n]/)
  })
  it('retains native short prompt behavior and accounts for cmd escaping expansion', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    expect(prepareZcodePrompt('zcode.cmd', [], 'hi').args).toEqual(['-p', 'hi'])
    const prepared = prepareZcodePrompt('zcode.cmd', [], '%!^"&'.repeat(1000))
    pending.push(prepared.cleanup)
    expect(prepared.args).toContain('--attach')
  })
})
