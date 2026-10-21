import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tos-lifecycle-'))
  roots.push(root)
  const app = join(root, 'app')
  const bin = join(root, 'bin')
  const units = join(root, 'units')
  mkdirSync(bin)
  mkdirSync(units)
  const command = (name: string, body: string) => {
    const path = join(bin, name)
    writeFileSync(path, `#!/bin/bash\n${body}\n`)
    chmodSync(path, 0o755)
  }
  command('systemctl', 'echo "$*" >> "$CALLS"; exit 5')
  command('getent', `case "$1" in
passwd) echo "test-user:x:123:123::\${ACCOUNT_HOME:-$APP/data/home}:/usr/sbin/nologin" ;;
group) echo "test-user:x:123:" ;;
esac`)
  command('id', 'echo 123')
  command('userdel', 'echo "userdel $*" >> "$CALLS"')
  command('groupdel', 'echo "groupdel $*" >> "$CALLS"')
  const calls = join(root, 'calls')
  const run = (script: string, action: string, env: Record<string, string> = {}) => {
    const source = readFileSync(resolve(`packages/tos/${script}.in`), 'utf8')
      .replaceAll('/usr/local/@APP_ID@', app)
      .replaceAll('/etc/systemd/system', units)
      .replaceAll('@SERVICE@', 'test-service')
      .replaceAll('@USER@', 'test-user')
    execFileSync('bash', ['-c', source, script, action], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, APP: app, CALLS: calls, ...env },
    })
  }
  const seed = () => {
    for (const directory of ['data/home', 'data/workspaces', 'logs', 'webui']) mkdirSync(join(app, directory), { recursive: true })
    writeFileSync(join(app, 'data/workspaces/saved'), 'keep on upgrade')
  }
  return { root, app, units, calls, run, seed }
}

describe.runIf(process.platform === 'linux')('TOS lifecycle scripts', () => {
  it.each(['remove', 'deconfigure', 'upgrade'])('prerm tolerates missing unit on %s', action => {
    const f = fixture()
    f.run('prerm', action)
    expect(readFileSync(f.calls, 'utf8')).toContain('stop test-service.service')
  })

  it.each(['remove', 'purge', 'disappear'])('cleans managed paths and owned identity on %s', action => {
    const f = fixture()
    f.seed()
    const external = join(f.root, 'external')
    mkdirSync(external)
    writeFileSync(join(external, 'keep'), 'external')
    symlinkSync(external, join(f.app, 'data/external'))
    symlinkSync(join(f.app, 'init.d/test-service.service'), join(f.units, 'test-service.service'))
    f.run('postrm', action)
    for (const path of ['data', 'logs', 'webui']) expect(existsSync(join(f.app, path))).toBe(false)
    expect(existsSync(join(external, 'keep'))).toBe(true)
    expect(readFileSync(f.calls, 'utf8')).toContain('userdel test-user')
    expect(readFileSync(f.calls, 'utf8')).toContain('groupdel test-user')
    // Repeated purge must also succeed when service-manager operations fail.
    f.run('postrm', action)
  })

  it('does not delete data on upgrade or an unrelated service identity on remove', () => {
    const f = fixture()
    f.seed()
    f.run('postrm', 'upgrade')
    expect(existsSync(join(f.app, 'data/workspaces/saved'))).toBe(true)
    f.run('postrm', 'remove', { ACCOUNT_HOME: '/unrelated/home' })
    expect(readFileSync(f.calls, 'utf8')).not.toContain('userdel')
    expect(readFileSync(f.calls, 'utf8')).not.toContain('groupdel')
  })

  it('unlinks top-level managed symlinks without deleting their targets', () => {
    const f = fixture()
    mkdirSync(f.app)
    const external = join(f.root, 'external')
    mkdirSync(external)
    writeFileSync(join(external, 'keep'), 'external')
    symlinkSync(external, join(f.app, 'data'))
    f.run('postrm', 'remove', { ACCOUNT_HOME: '/unrelated/home' })
    expect(existsSync(join(f.app, 'data'))).toBe(false)
    expect(existsSync(join(external, 'keep'))).toBe(true)
  })
})

it('registers the application unit in a standard search path without overwriting another unit', () => {
  const source = readFileSync(resolve('packages/tos/postinst.in'), 'utf8')
  expect(source).toContain('unit="/etc/systemd/system/@SERVICE@.service"')
  expect(source).toContain('ln -s "$target" "$unit"')
  expect(source).toContain('Refusing to overwrite unrelated systemd unit')
  expect(source).toContain('systemctl enable "@SERVICE@.service"')
})
