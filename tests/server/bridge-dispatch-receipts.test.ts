import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Durable dispatch admission in the Agent Bridge, exercised in real Python processes on one receipt file.
const BRIDGE = resolve('packages/server/src/modules/hermes/services/bridge/python')

function receipts(home: string, script: string): string {
  return execFileSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(BRIDGE)})
import bridge_dispatch_receipts as r
from pathlib import Path
home = Path(${JSON.stringify(home)})
${script}`], { encoding: 'utf-8' }).trim()
}

describe('bridge dispatch receipts', () => {
  it('admits a dispatch once and reports it accepted, also from a later process', () => {
    const home = mkdtempSync(join(tmpdir(), 'dispatch-receipts-'))
    try {
      expect(receipts(home, "print(r.admit(home, 'inst:1', 'run-a')); r.confirm_dispatched(home, 'inst:1')")).toBe('accepted')
      // A bridge restart is a new process on the same receipt file.
      expect(receipts(home, "print(r.resolve(home, 'inst:1'))")).toBe('accepted')
      expect(receipts(home, "print(r.admit(home, 'inst:1', 'run-b'))")).toBe('duplicate')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('never reports an admitted dispatch accepted before its worker started', () => {
    const home = mkdtempSync(join(tmpdir(), 'dispatch-receipts-'))
    try {
      // A crash between admission and worker start leaves it preparing: explicitly uncertain.
      expect(receipts(home, "print(r.admit(home, 'inst:3', 'run-c'))")).toBe('accepted')
      expect(receipts(home, "print(r.resolve(home, 'inst:3'))")).toBe('uncertain')
      // A definite startup failure settles it as never dispatched.
      expect(receipts(home, "r.admit(home, 'inst:4', 'run-d'); r.settle_failed(home, 'inst:4'); print(r.resolve(home, 'inst:4'))")).toBe('refused')
      expect(receipts(home, "print(r.admit(home, 'inst:4', 'run-e'))")).toBe('refused')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('a dispatch resolved before it arrived is refused for good, even after a restart', () => {
    const home = mkdtempSync(join(tmpdir(), 'dispatch-receipts-'))
    try {
      expect(receipts(home, "print(r.resolve(home, 'inst:2'))")).toBe('refused')
      expect(receipts(home, "print(r.admit(home, 'inst:2', 'run-late'))")).toBe('refused')
      expect(receipts(home, "print(r.resolve(home, 'inst:2'))")).toBe('refused')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
