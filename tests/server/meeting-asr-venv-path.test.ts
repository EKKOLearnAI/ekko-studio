import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Regression coverage for v0.7.16: the meeting-asr Python venv must live under
 * the data directory, NOT under `dist/server/services/meeting-asr/python-backend/`.
 *
 * Original incident (audit #1, RK3528 audit): the service was started by a
 * non-root user after `dist/` had been created by root, so `python -m venv`
 * died with EACCES. Co-locating the venv with `config.json` (which the service
 * already writes successfully) keeps ownership symmetric.
 *
 * These tests pin:
 *  - resolveVenvPath() returns `<dataDir>/.venv` regardless of backendPath
 *  - resolveVenvMarkerPath() returns `<venvPath>/.hermes-ready`
 *  - getDataDir() honors the MEETING_ASR_DATA_DIR env override (the contract
 *    `deploy-source-armbian.sh` and `hermes-web-ui.service` rely on).
 *  - the source file no longer contains the legacy `backendPath, '.venv'` literal
 */

const tempDirs: string[] = []
let originalEnv: NodeJS.ProcessEnv

function mkTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop()
    if (d) rmSync(d, { recursive: true, force: true })
  }
  // Restore env touched by MEETING_ASR_DATA_DIR tests.
  delete process.env.MEETING_ASR_DATA_DIR
  if (originalEnv) {
    for (const k of Object.keys(process.env)) {
      if (!(k in originalEnv)) delete process.env[k]
    }
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v !== undefined) process.env[k] = v
    }
  }
})

describe('MeetingASRService path resolution (v0.7.16 venv relocation)', () => {
  beforeEach(() => {
    originalEnv = { ...process.env }
  })

  it('resolveVenvPath places the venv under dataDir, never under the python source dir', async () => {
    const mod = await import('../../packages/server/src/modules/studio/services/meeting-asr/index')
    const svc = mod.meetingASRService as any

    const dataDir = mkTemp('hermes-data-')
    const backendDir = mkTemp('hermes-backend-')
    // Sanity: prove the test inputs are not accidentally the same path.
    expect(dataDir).not.toBe(backendDir)

    const venvPath = svc.resolveVenvPath(dataDir, backendDir)
    expect(venvPath).toBe(join(dataDir, '.venv'))
    expect(venvPath.startsWith(backendDir)).toBe(false)

    const marker = svc.resolveVenvMarkerPath(venvPath)
    expect(marker).toBe(join(dataDir, '.venv', '.hermes-ready'))
  })

  it('getDataDir honors MEETING_ASR_DATA_DIR before falling back to Web UI home', async () => {
    const override = mkTemp('hermes-override-')
    process.env.MEETING_ASR_DATA_DIR = override

    const mod = await import('../../packages/server/src/modules/studio/services/meeting-asr/index')
    // singleton is process-global; reset so _config is empty
    ;(mod.meetingASRService as any)._config = {}
    const resolved = (mod.meetingASRService as any).getDataDir()
    expect(resolved).toBe(override)
  })

  it('getVenvPythonPath resolves to a binary inside the data-dir venv, not the source dir', async () => {
    const dataDir = mkTemp('hermes-pyvenv-')
    const backendDir = mkTemp('hermes-backend-')
    const mod = await import('../../packages/server/src/modules/studio/services/meeting-asr/index')
    const svc = mod.meetingASRService as any
    const venvPath = svc.resolveVenvPath(dataDir, backendDir)
    const pythonPath = svc.getVenvPythonPath(venvPath)

    // The resolved binary lives under the data-dir venv, not the python-backend
    // source directory — same ownership guarantees as config.json.
    expect(pythonPath.startsWith(dataDir)).toBe(true)
    expect(pythonPath.startsWith(backendDir)).toBe(false)
  })

  it('source contract: venv creation never targets pythonBackendPath/.venv', async () => {
    const { readFileSync } = await import('fs')
    // The creation logic now lives in venv-manager.ts (v0.8 modularization);
    // index.ts keeps delegating methods with the same names/semantics.
    const src = readFileSync(
      join(process.cwd(), 'packages/server/src/modules/studio/services/meeting-asr/venv-manager.ts'),
      'utf-8',
    )

    // The `createVenv` helper must target the data-dir venv, not the
    // backend-path venv. We assert that the `python -m venv` spawn line
    // uses `venvPath` (the data-dir one), not `legacyVenvPath`.
    //
    // The migration block legitimately references `path.join(backendPath,
    // '.venv')` to DETECT an old venv — that's fine; what's forbidden is
    // CREATING a venv there.
    expect(src).toMatch(/resolveVenvPath\(/)
    // The venv creation spawn must use venvPath (data-dir), not legacyVenvPath.
    expect(src).toMatch(/-m',\s*'venv',\s*venvPath/)
    // The new helper call must exist.
    expect(src).toMatch(/resolveVenvPath\(/)
  })

  it('source contract: getDataDir + pip install -r keep using absolute requirements path', async () => {
    const { readFileSync } = await import('fs')
    const indexSrc = readFileSync(
      join(process.cwd(), 'packages/server/src/modules/studio/services/meeting-asr/index.ts'),
      'utf-8',
    )
    const venvSrc = readFileSync(
      join(process.cwd(), 'packages/server/src/modules/studio/services/meeting-asr/venv-manager.ts'),
      'utf-8',
    )

    // getDataDir reads MEETING_ASR_DATA_DIR so deploy + runtime agree.
    expect(indexSrc).toMatch(/process\.env\.MEETING_ASR_DATA_DIR/)
    // pip install -r uses an absolute path so cwd can be anywhere
    // (the requirements path is computed in index.ts and injected).
    expect(indexSrc).toMatch(/path\.join\(__dirname,\s*['"]requirements\.txt['"]\)/)
    expect(venvSrc).toMatch(/opts\.requirementsPath/)
  })
})

describe('Meeting ASR shared runtime paths', () => {
  beforeEach(() => { originalEnv = { ...process.env } })

  it('uses the same discovered certificate directory as the Node server', async () => {
    const deployDir = mkTemp('meeting-tls-deploy-')
    const certDir = join(deployDir, 'packages', 'certs')
    mkdirSync(certDir, { recursive: true })
    writeFileSync(join(certDir, 'server.crt'), 'test certificate')
    writeFileSync(join(certDir, 'server.key'), 'test key')
    process.env.DEPLOY_DIR = deployDir
    process.env.HERMES_WEB_UI_MEETING_ASR_TLS = 'true'
    delete process.env.HERMES_WEB_UI_SSL_CERTFILE
    delete process.env.HERMES_WEB_UI_SSL_KEYFILE
    const { MeetingASRService } = await import('../../packages/server/src/modules/studio/services/meeting-asr')
    const service = new MeetingASRService() as any
    expect(service._uvicornTlsArgs()).toEqual([
      '--ssl-certfile', join(certDir, 'server.crt'), '--ssl-keyfile', join(certDir, 'server.key'),
    ])
  })

  it('honors explicit uvicorn certificate overrides', async () => {
    process.env.HERMES_WEB_UI_MEETING_ASR_TLS = 'true'
    process.env.HERMES_WEB_UI_SSL_CERTFILE = '/custom/certificate.pem'
    process.env.HERMES_WEB_UI_SSL_KEYFILE = '/custom/private-key.pem'
    const { MeetingASRService } = await import('../../packages/server/src/modules/studio/services/meeting-asr')
    const service = new MeetingASRService() as any
    expect(service._uvicornTlsArgs()).toEqual([
      '--ssl-certfile', '/custom/certificate.pem', '--ssl-keyfile', '/custom/private-key.pem',
    ])
  })

  it('keeps default ASR state under the canonical Web UI state alias', async () => {
    delete process.env.MEETING_ASR_DATA_DIR
    delete process.env.HERMES_WEB_UI_HOME
    const stateDir = mkTemp('meeting-state-alias-')
    process.env.HERMES_WEBUI_STATE_DIR = stateDir
    const { MeetingASRService } = await import('../../packages/server/src/modules/studio/services/meeting-asr')
    expect((new MeetingASRService() as any).getDataDir()).toBe(join(stateDir, 'meeting-asr'))
  })
})
