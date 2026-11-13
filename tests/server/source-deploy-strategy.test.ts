import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpdateError } from '../../packages/server/src/modules/studio/services/update/errors'
import { buildSourceDeployCommand, buildSourceDeployEnv } from '../../packages/server/src/modules/studio/services/update/strategies/source-deploy'

describe('source deploy strategy', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('builds the script command through a discovered bash executable on Linux', () => {
    expect(buildSourceDeployCommand(
      '/opt/hermes-web-ui/scripts/update-source-deploy.sh',
      '0.6.13',
      () => '/bin/bash',
    )).toEqual({
      command: '/bin/bash',
      args: ['/opt/hermes-web-ui/scripts/update-source-deploy.sh', '--version', '0.6.13'],
    })
  })

  it('builds the script command through a discovered bash executable on Windows', () => {
    expect(buildSourceDeployCommand(
      '/opt/hermes-web-ui/scripts/update-source-deploy.sh',
      '0.6.13',
      () => 'C:\\Program Files\\Git\\bin\\bash.exe',
    )).toEqual({
      command: 'C:\\Program Files\\Git\\bin\\bash.exe',
      args: ['/opt/hermes-web-ui/scripts/update-source-deploy.sh', '--version', '0.6.13'],
    })
  })

  it('fails with UpdateError when bash is unavailable', () => {
    expect(() => buildSourceDeployCommand(
      '/opt/hermes-web-ui/scripts/update-source-deploy.sh',
      '0.6.13',
      () => undefined,
    )).toThrow(UpdateError)
    expect(() => buildSourceDeployCommand(
      '/opt/hermes-web-ui/scripts/update-source-deploy.sh',
      '0.6.13',
      () => undefined,
    )).toThrow(/requires bash, but no bash executable was found in PATH/)
  })

  it('builds source deploy env with explicit agent upgrade scope', () => {
    expect(buildSourceDeployEnv(
      {
        enabled: true,
        strategy: 'source-deploy',
        includeAgentUpgrade: false,
        packageName: '@quanthermes/hermes-web-ui',
        registry: 'https://registry.npmjs.org',
        sourceLabel: 'npm',
        distTag: 'latest',
        cliBin: 'hermes-web-ui.mjs',
        script: '/opt/hermes-web-ui/scripts/update-source-deploy.sh',
        runnerService: 'hermes-web-ui-update.service',
        runnerRequestFile: '/home/hermesui/.hermes-web-ui/updates/update-runner-request.json',
        channel: 'stable',
        manifestUrl: '',
        manifestUrls: [],
        manifestBaseUrl: '',
        packageType: 'source-deploy',
        installerScript: '',
        stagingDir: '/tmp/staging',
        backupDir: '/tmp/backups',
        healthcheckUrl: 'http://127.0.0.1:6060/health',
        stateFile: '/tmp/update-state.json',
        logDir: '/tmp/update-logs',
        manifestTimeoutMs: 100,
        packageTimeoutMs: 100,
        downloadRetries: 0,
        downloadRetryDelayMs: 1,
        healthcheckTimeoutMs: 2_000,
        healthcheckIntervalMs: 2_000,
        healthcheckRetries: 15,
        healthcheckInitialDelayMs: 5_000,
        autoInstallDependencies: true,
        minFreeSpaceBytes: 1024,
        taskHeartbeatTimeoutMs: 7_200_000,
      },
      { PATH: process.env.PATH || '' },
      '0.6.33',
      {
        deployDir: '/opt/hermes-web-ui',
        webUiHome: '/home/hermesui/.hermes-web-ui',
        uploadDir: '/home/hermesui/.hermes-web-ui/upload',
        hermesHome: '/opt/hermes-web-ui/hermes_data',
      },
      'update-task-123',
    )).toEqual(expect.objectContaining({
      HERMES_WEB_UI_UPDATE_VERSION: '0.6.33',
      HERMES_WEB_UI_UPDATE_TASK_ID: 'update-task-123',
      HERMES_WEB_UI_UPDATE_AUTO_INSTALL_DEPENDENCIES: 'true',
      HERMES_WEB_UI_UPDATE_INCLUDE_AGENT_UPGRADE: 'false',
      HERMES_WEB_UI_UPDATE_HEALTHCHECK_URL: 'http://127.0.0.1:6060/health',
    }))
  })

  it('prefers manifest healthcheckUrl over the global update config', () => {
    const env = buildSourceDeployEnv(
      {
        enabled: true,
        strategy: 'source-deploy',
        includeAgentUpgrade: false,
        packageName: '@quanthermes/hermes-web-ui',
        registry: 'https://registry.npmjs.org',
        sourceLabel: 'npm',
        distTag: 'latest',
        cliBin: 'hermes-web-ui.mjs',
        script: '/opt/hermes-web-ui/scripts/update-source-deploy.sh',
        runnerService: 'hermes-web-ui-update.service',
        runnerRequestFile: '/home/hermesui/.hermes-web-ui/updates/update-runner-request.json',
        channel: 'stable',
        manifestUrl: '',
        manifestUrls: [],
        manifestBaseUrl: '',
        packageType: 'source-deploy',
        installerScript: '',
        stagingDir: '/tmp/staging',
        backupDir: '/tmp/backups',
        healthcheckUrl: 'http://127.0.0.1:6060/health',
        stateFile: '/tmp/update-state.json',
        logDir: '/tmp/update-logs',
        manifestTimeoutMs: 100,
        packageTimeoutMs: 100,
        downloadRetries: 0,
        downloadRetryDelayMs: 1,
        healthcheckTimeoutMs: 2_000,
        healthcheckIntervalMs: 2_000,
        healthcheckRetries: 15,
        healthcheckInitialDelayMs: 5_000,
        autoInstallDependencies: true,
        minFreeSpaceBytes: 1024,
        taskHeartbeatTimeoutMs: 7_200_000,
      },
      { PATH: process.env.PATH || '' },
      '0.7.0',
      {
        deployDir: '/opt/hermes-web-ui',
        webUiHome: '/home/hermesui/.hermes-web-ui',
        uploadDir: '/home/hermesui/.hermes-web-ui/upload',
        hermesHome: '/opt/hermes-web-ui/hermes_data',
      },
      'update-task-456',
      {
        version: '0.7.0',
        channel: 'stable',
        sourceLabel: 'OSS Release',
        packageType: 'source-deploy',
        manifestUrl: 'https://updates.example.com/stable/latest.json',
        artifactFormat: 'tar.gz',
        sourceUrl: 'https://oss.example.com/sources/v0.7.0/source.tar.gz',
        sourceSha256: 'a'.repeat(64),
        releasedAt: '2026-07-15T00:00:00Z',
        minCurrentVersion: '0.6.0',
        notesUrl: '',
        sourceSize: 4096,
        healthcheckUrl: 'https://canary.example.com/health',
      },
    )

    expect(env.HERMES_WEB_UI_UPDATE_HEALTHCHECK_URL).toBe('https://canary.example.com/health')
  })

  it('falls back to the global update healthcheckUrl when the manifest omits one', () => {
    const env = buildSourceDeployEnv(
      {
        enabled: true,
        strategy: 'source-deploy',
        includeAgentUpgrade: false,
        packageName: '@quanthermes/hermes-web-ui',
        registry: 'https://registry.npmjs.org',
        sourceLabel: 'npm',
        distTag: 'latest',
        cliBin: 'hermes-web-ui.mjs',
        script: '/opt/hermes-web-ui/scripts/update-source-deploy.sh',
        runnerService: 'hermes-web-ui-update.service',
        runnerRequestFile: '/home/hermesui/.hermes-web-ui/updates/update-runner-request.json',
        channel: 'stable',
        manifestUrl: '',
        manifestUrls: [],
        manifestBaseUrl: '',
        packageType: 'source-deploy',
        installerScript: '',
        stagingDir: '/tmp/staging',
        backupDir: '/tmp/backups',
        healthcheckUrl: 'http://127.0.0.1:6060/health',
        stateFile: '/tmp/update-state.json',
        logDir: '/tmp/update-logs',
        manifestTimeoutMs: 100,
        packageTimeoutMs: 100,
        downloadRetries: 0,
        downloadRetryDelayMs: 1,
        healthcheckTimeoutMs: 2_000,
        healthcheckIntervalMs: 2_000,
        healthcheckRetries: 15,
        healthcheckInitialDelayMs: 5_000,
        autoInstallDependencies: true,
        minFreeSpaceBytes: 1024,
        taskHeartbeatTimeoutMs: 7_200_000,
      },
      { PATH: process.env.PATH || '' },
      '0.7.1',
      {
        deployDir: '/opt/hermes-web-ui',
        webUiHome: '/home/hermesui/.hermes-web-ui',
        uploadDir: '/home/hermesui/.hermes-web-ui/upload',
        hermesHome: '/opt/hermes-web-ui/hermes_data',
      },
      'update-task-789',
      {
        version: '0.7.1',
        channel: 'stable',
        sourceLabel: 'OSS Release',
        packageType: 'source-deploy',
        manifestUrl: 'https://updates.example.com/stable/latest.json',
        artifactFormat: 'tar.gz',
        sourceUrl: 'https://oss.example.com/sources/v0.7.1/source.tar.gz',
        sourceSha256: 'b'.repeat(64),
        releasedAt: '2026-07-20T00:00:00Z',
        minCurrentVersion: '0.6.0',
        notesUrl: '',
        sourceSize: 4096,
        healthcheckUrl: '',
      },
    )

    expect(env.HERMES_WEB_UI_UPDATE_HEALTHCHECK_URL).toBe('http://127.0.0.1:6060/health')
  })
})
