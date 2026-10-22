import { sdk } from './sdk'

export const uiPort = 6060
export const runtimeEnv = {
  NODE_ENV: 'production',
  HOME: '/home/agent',
  HERMES_HOME: '/home/agent/.hermes',
  HERMES_WEB_UI_HOME: '/home/agent/.hermes-web-ui',
  HERMES_WEBUI_STATE_DIR: '/home/agent/.hermes-web-ui',
  WORKSPACE_BASE: '/home/agent/workspaces',
  NPM_CONFIG_PREFIX: '/home/agent/.hermes-web-ui/coding-agent/npm',
  HERMES_WEB_UI_MANAGED_GATEWAY: '1',
  HERMES_ALLOW_ROOT_GATEWAY: '1',
  HERMES_WEB_UI_DISABLE_UPDATE_CHECK: '1',
  HERMES_LAN_DISCOVERY_ENABLED: 'false',
  STUDIO_P2P_ENABLED: '0',
  BIND_HOST: '0.0.0.0',
  PORT: String(uiPort),
}

export const dataMounts = () =>
  sdk.Mounts.of().mountVolume({
    volumeId: 'main',
    subpath: null,
    mountpoint: '/home/agent',
    readonly: false,
  })

// Uses upstream's reset CLI and authenticated password API, not an invented hash.
// The action is only available while stopped. Its temporary server binds loopback.
export const passwordBootstrap = String.raw`
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
const password = process.env.STARTOS_ADMIN_PASSWORD;
if (!password || password.length < 32) throw new Error('A generated admin password is required');
mkdirSync(process.env.WORKSPACE_BASE, { recursive: true });
execFileSync(process.execPath, ['/app/bin/hermes-web-ui.mjs', 'reset-default-login'], {
  env: process.env, stdio: 'ignore', timeout: 30000,
});
const childEnv = { ...process.env, BIND_HOST: '127.0.0.1', PORT: '18648',
  HERMES_WEB_UI_DISABLE_GATEWAY_AUTOSTART: '1', HERMES_WEB_UI_MANAGED_GATEWAY: '0' };
delete childEnv.STARTOS_ADMIN_PASSWORD;
const child = spawn(process.execPath, ['/app/dist/server/index.js'], {
  env: childEnv, cwd: '/app', stdio: 'ignore',
});
const exited = once(child, 'exit');
let exitError;
child.on('error', error => { exitError = error; });
const base = 'http://127.0.0.1:18648';
try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (exitError || child.exitCode !== null) throw new Error('Credential setup server exited');
    try {
      const response = await fetch(base + '/api/auth/status', { signal: AbortSignal.timeout(1000) });
      ready = response.ok;
    } catch {}
    if (ready) break;
    await delay(500);
  }
  if (!ready) throw new Error('Credential setup server did not become ready');
  const post = (path, body, token) => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
  });
  const first = await post('/api/auth/login', { username: 'admin', password: '123456' });
  if (!first.ok) throw new Error('Upstream admin bootstrap login failed');
  const { token } = await first.json();
  const changed = await post('/api/auth/change-password', {
    currentPassword: '123456', newPassword: password,
  }, token);
  if (!changed.ok || !(await changed.json()).success) throw new Error('Upstream password change failed');
  const login = await post('/api/auth/login', { username: 'admin', password });
  if (!login.ok) throw new Error('Generated password was not accepted');
  const obsolete = await post('/api/auth/login', { username: 'admin', password: '123456' });
  if (obsolete.status !== 401) throw new Error('Default password was not rejected');
  console.log('Administrator password applied and verified through the upstream API');
} finally {
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  try { await exited; } finally { clearTimeout(timer); }
}
`
