import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const wrapper = join(process.cwd(), 'bin', 'start-studio-all.sh')

function runWrapper(env: NodeJS.ProcessEnv, args: string[] = []) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(wrapper, args, { env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

describe('Docker startup wrapper', () => {
  it('continues when an explicitly configured optional Hermes patch fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-startup-'))
    const fakeBin = join(root, 'bin')
    const marker = join(root, 'order')
    await mkdir(fakeBin)
    await writeFile(join(root, 'failing-patch.sh'), '#!/usr/bin/env bash\nprintf "patch\\n" >> "$STARTUP_MARKER"\nexit 17\n', { mode: 0o755 })
    await writeFile(join(fakeBin, 'node'), '#!/usr/bin/env bash\nprintf "node\\n" >> "$STARTUP_MARKER"\nprintf "node-started\\n"\n', { mode: 0o755 })

    const result = await runWrapper({
      ...process.env,
      HERMES_PATCH_SCRIPT: join(root, 'failing-patch.sh'),
      STARTUP_MARKER: marker,
      PATH: `${fakeBin}:${process.env.PATH}`,
    })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('node-started')
    expect(result.stderr).toContain('optional Hermes patch failed')
    await expect(import('node:fs/promises').then(fs => fs.readFile(marker, 'utf8'))).resolves.toBe('patch\nnode\n')
  })

  it('continues when the configured optional Hermes patch is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-startup-'))
    const fakeBin = join(root, 'bin')
    await mkdir(fakeBin)
    await writeFile(join(fakeBin, 'node'), '#!/usr/bin/env bash\nprintf "node-started\\n"\n', { mode: 0o755 })

    const result = await runWrapper({
      ...process.env,
      HERMES_PATCH_SCRIPT: join(root, 'missing-patch.sh'),
      PATH: `${fakeBin}:${process.env.PATH}`,
    })

    expect(result.code).toBe(0)
    expect(result.stdout).toBe('node-started\n')
    expect(result.stderr).toContain('optional Hermes patch not found')
  })

  it('runs a compatible patch before starting the server and forwards arguments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hermes-startup-'))
    const fakeBin = join(root, 'bin')
    const marker = join(root, 'patch-ran')
    await mkdir(fakeBin)
    await writeFile(join(root, 'patch.sh'), '#!/usr/bin/env bash\nprintf "patched" > "$STARTUP_MARKER"\n', { mode: 0o755 })
    await writeFile(join(fakeBin, 'node'), '#!/usr/bin/env bash\nprintf "node-started:%s\\n" "$*"\n', { mode: 0o755 })

    const result = await runWrapper({
      ...process.env,
      HERMES_PATCH_SCRIPT: join(root, 'patch.sh'),
      STARTUP_MARKER: marker,
      PATH: `${fakeBin}:${process.env.PATH}`,
    }, ['--port', '6060'])

    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`node-started:${process.cwd()}/bin/../dist/server/index.js --port 6060\n`)
    await expect(import('node:fs/promises').then(fs => fs.readFile(marker, 'utf8'))).resolves.toBe('patched')
  })
})
