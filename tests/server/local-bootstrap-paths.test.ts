import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { getServerCertDir } from '../../packages/server/src/modules/studio/public/config'

const roots: string[] = []
function root() {
  const value = mkdtempSync(join(tmpdir(), 'studio-tls-path-'))
  roots.push(value)
  return value
}
function certificates(directory: string) {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'server.crt'), 'test certificate')
  writeFileSync(join(directory, 'server.key'), 'test key')
}
afterEach(() => roots.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })))

it('shares the deployed certificate pair with HTTP, loopback selection and ASR', () => {
  const deploy = root()
  certificates(join(deploy, 'packages/certs'))
  expect(getServerCertDir({ DEPLOY_DIR: deploy })).toBe(join(deploy, 'packages/certs'))
  certificates(join(deploy, 'certs'))
  expect(getServerCertDir({ DEPLOY_DIR: deploy })).toBe(join(deploy, 'certs'))
})

it('requires a complete pair and falls back to the bootstrap installer location', () => {
  const deploy = root()
  mkdirSync(join(deploy, 'certs'))
  writeFileSync(join(deploy, 'certs/server.crt'), 'incomplete')
  certificates(join(deploy, 'packages/server/certs'))
  expect(getServerCertDir({ DEPLOY_DIR: deploy })).toBe(join(deploy, 'packages/server/certs'))
  expect(getServerCertDir({ DEPLOY_DIR: root() })).toMatch(/\/certs$/)
})
