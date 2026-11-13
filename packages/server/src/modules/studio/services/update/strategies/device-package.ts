import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { basename, join, resolve } from 'path'
import { isNodeVersionRangeSatisfied } from '../device-package-contract'
import { UpdateError } from '../errors'
import { fetchDevicePackageManifest } from '../manifest-client'
import { describeUpdateNetworkError, downloadUpdateBinaryToFile, UpdateBinaryValidationError } from '../network-client'
import { compareSemver } from '../version-compare'
import type { DevicePackageManifest, UpdateConfig, UpdateRuntimePaths } from '../types'
import { buildShellScriptCommand, type CommandResolver } from './script-command'

function sanitizeVersionSegment(version: string): string {
  return version.replace(/[^A-Za-z0-9._-]/g, '_')
}

function inferPackageFilename(manifest: DevicePackageManifest): string {
  try {
    const sourceUrl = manifest.packageUrls?.[0] || manifest.packageUrl
    const pathname = new URL(sourceUrl).pathname
    const fromUrl = basename(pathname)
    if (fromUrl) return fromUrl
  } catch {
    // Fall back to a deterministic filename when the URL is relative or invalid.
  }
  return `hermes-web-ui-device-v${sanitizeVersionSegment(manifest.version)}.tar.gz`
}

export function getDevicePackageExecutionMessage(): string {
  return 'Update source is not fully configured. Set WEBUI_UPDATE_MANIFEST_URL or WEBUI_UPDATE_MANIFEST_BASE_URL, WEBUI_UPDATE_INSTALLER_SCRIPT, and WEBUI_UPDATE_RUNNER_SERVICE.'
}

export const DEFAULT_INSTALLER_SCRIPT_PATH = 'scripts/install-device-package.sh'

export function sha256OfFile(filePath: string): string {
  const hash = createHash('sha256')
  hash.update(readFileSync(filePath))
  return hash.digest('hex')
}

/**
 * Compare the device's on-disk installer script against the manifest's
 * declared fingerprint. Throws `update_installer_script_stale` when the local
 * copy does not match — this catches the "fixed in repo but never published
 * to device" failure mode where the install script on a device is older than
 * what the new manifest expects.
 *
 * No-op when the manifest does not declare a fingerprint (backward
 * compatibility with manifests published before this contract was added).
 */
export function assertInstallerScriptCompatible(
  deployDir: string,
  manifest: DevicePackageManifest,
): void {
  const expected = manifest.installerScriptSha256
  if (!expected) return

  const relativePath = manifest.installerScriptPath || DEFAULT_INSTALLER_SCRIPT_PATH
  const absolutePath = resolve(deployDir, relativePath)
  if (!existsSync(absolutePath)) {
    throw new UpdateError(
      'update_installer_script_missing',
      `Device install script is missing on disk: ${absolutePath}. The deploy directory may be incomplete; reinstall before retrying.`,
      409,
      {
        deployDir,
        installerScriptPath: relativePath,
        absolutePath,
      },
    )
  }

  const actual = sha256OfFile(absolutePath)
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new UpdateError(
      'update_installer_script_stale',
      `Device install script is out of date. The script on disk at ${absolutePath} no longer matches the version bundled with the update manifest. The current Web UI package must be reinstalled (or a full source deploy run) so the installer is refreshed before this update can proceed.`,
      409,
      {
        deployDir,
        installerScriptPath: relativePath,
        absolutePath,
        expectedSha256: expected.toLowerCase(),
        actualSha256: actual.toLowerCase(),
      },
    )
  }
}

export function assertDevicePackageExecution(update: UpdateConfig): void {
  if (
    !(update.manifestUrl || update.manifestBaseUrl || update.manifestUrls?.length)
    || !update.installerScript
    || !update.runnerService
    || !update.runnerRequestFile
  ) {
    throw new UpdateError('update_execution_misconfigured', getDevicePackageExecutionMessage())
  }
}

export async function resolveDevicePackageManifest(update: UpdateConfig): Promise<DevicePackageManifest> {
  return fetchDevicePackageManifest(update)
}

export function assertDevicePackageCompatibility(manifest: DevicePackageManifest, currentVersion: string): void {
  if (!isNodeVersionRangeSatisfied(manifest.compatibleNodeRange, process.versions.node)) {
    throw new UpdateError(
      'update_incompatible_node',
      `Device package ${manifest.version} requires Node.js ${manifest.compatibleNodeRange}, current runtime is ${process.versions.node}.`,
      409,
    )
  }

  const minCompare = compareSemver(currentVersion, manifest.minCurrentVersion)
  if (minCompare == null) {
    throw new UpdateError(
      'update_manifest_invalid',
      `Cannot compare current version ${currentVersion} with manifest minCurrentVersion ${manifest.minCurrentVersion}.`,
    )
  }
  if (minCompare < 0) {
    throw new UpdateError(
      'update_incompatible_current_version',
      `Current version ${currentVersion} is below the minimum supported update version ${manifest.minCurrentVersion}.`,
      409,
    )
  }
}

export async function downloadAndVerifyDevicePackage(
  update: UpdateConfig,
  manifest: DevicePackageManifest,
): Promise<{ artifactPath: string }> {
  const versionSegment = sanitizeVersionSegment(manifest.version)
  const workDir = resolve(update.stagingDir, `device-package-${versionSegment}`)
  mkdirSync(workDir, { recursive: true })
  const artifactPath = resolve(workDir, inferPackageFilename(manifest))

  const packageUrls = [...new Set((manifest.packageUrls || [manifest.packageUrl]).filter(Boolean))]
  const failures: Array<Record<string, unknown>> = []

  for (const packageUrl of packageUrls) {
    try {
      const candidate = await downloadUpdateBinaryToFile(packageUrl, artifactPath, {
        timeoutMs: update.packageTimeoutMs,
        retries: update.downloadRetries,
        retryDelayMs: update.downloadRetryDelayMs,
        expectedBytes: manifest.size > 0 ? manifest.size : undefined,
        expectedSha256: manifest.sha256,
      })
      if (!candidate.ok) {
        failures.push({
          packageUrl,
          status: candidate.status,
          transport: candidate.transport,
          attempts: candidate.attempts,
        })
        continue
      }
      return { artifactPath }
    } catch (err) {
      if (packageUrls.length === 1 && err instanceof UpdateBinaryValidationError) {
        if (err.reason === 'sha256_mismatch') {
          throw new UpdateError(
            'update_sha256_mismatch',
            `Downloaded device package checksum mismatch for ${manifest.version}.`,
            409,
            {
              expectedSha256: manifest.sha256,
              actualSha256: err.actualSha256,
              actualBytes: err.actualBytes,
              artifactPath,
              packageUrl,
            },
          )
        }

        throw new UpdateError(
          'update_download_failed',
          `Downloaded device package validation failed for ${manifest.version}.`,
          409,
          {
            reason: err.reason,
            expectedBytes: err.expectedBytes,
            actualBytes: err.actualBytes,
            expectedSha256: err.expectedSha256,
            actualSha256: err.actualSha256,
            artifactPath,
            packageUrl,
          },
        )
      }
      failures.push({
        packageUrl,
        ...describeUpdateNetworkError(err),
      })
    }
  }

  throw new UpdateError(
    'update_package_fetch_failed',
    `Failed to download device package ${manifest.version} from ${packageUrls[0] || manifest.packageUrl}.`,
    502,
    {
      packageUrl: packageUrls[0] || manifest.packageUrl,
      packageUrls,
      failures,
    },
  )
}

export function buildDevicePackageInstallEnv(
  update: UpdateConfig,
  baseEnv: NodeJS.ProcessEnv,
  manifest: DevicePackageManifest,
  artifactPath: string,
  paths: UpdateRuntimePaths,
  taskId: string,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    APP_USER: baseEnv.APP_USER || 'hermesui',
    DEPLOY_DIR: paths.deployDir,
    HERMES_HOME: paths.hermesHome || baseEnv.HERMES_HOME || '',
    HERMES_HOME_DIR: paths.hermesHome || baseEnv.HERMES_HOME_DIR || '',
    HERMES_WEB_UI_HOME: paths.webUiHome,
    HERMES_WEBUI_STATE_DIR: paths.webUiHome,
    UPLOAD_DIR: paths.uploadDir,
    HERMES_WEB_UI_UPDATE_VERSION: manifest.version,
    HERMES_WEB_UI_UPDATE_PACKAGE_ARCHIVE: artifactPath,
    HERMES_WEB_UI_UPDATE_STAGING_DIR: update.stagingDir,
    HERMES_WEB_UI_UPDATE_BACKUP_DIR: update.backupDir,
    HERMES_WEB_UI_UPDATE_STATE_FILE: update.stateFile,
    HERMES_WEB_UI_UPDATE_LOG_DIR: update.logDir,
    HERMES_WEB_UI_UPDATE_TASK_ID: taskId,
    HERMES_WEB_UI_UPDATE_HEALTHCHECK_URL: manifest.healthcheckUrl || update.healthcheckUrl,
    HERMES_WEB_UI_UPDATE_HEALTHCHECK_TIMEOUT_MS: String(update.healthcheckTimeoutMs),
    HERMES_WEB_UI_UPDATE_HEALTHCHECK_INTERVAL_MS: String(update.healthcheckIntervalMs),
    HERMES_WEB_UI_UPDATE_HEALTHCHECK_RETRIES: String(update.healthcheckRetries),
    HERMES_WEB_UI_UPDATE_HEALTHCHECK_INITIAL_DELAY_MS: String(update.healthcheckInitialDelayMs),
    HERMES_WEB_UI_UPDATE_EXPECTED_SHA256: manifest.sha256,
    HERMES_WEB_UI_UPDATE_INSTALLER_SCRIPT_PATH: manifest.installerScriptPath || DEFAULT_INSTALLER_SCRIPT_PATH,
    HERMES_WEB_UI_UPDATE_INSTALLER_SCRIPT_SHA256: manifest.installerScriptSha256 || '',
    HERMES_WEB_UI_UPDATE_AUTO_INSTALL_DEPENDENCIES: update.autoInstallDependencies ? 'true' : 'false',
    HERMES_WEB_UI_UPDATE_INCLUDE_AGENT_UPGRADE: update.includeAgentUpgrade ? 'true' : 'false',
  }
}

export function buildDevicePackageReconcileEnv(
  update: UpdateConfig,
  baseEnv: NodeJS.ProcessEnv,
  manifest: DevicePackageManifest,
  paths: UpdateRuntimePaths,
  taskId: string,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    APP_USER: baseEnv.APP_USER || 'hermesui',
    DEPLOY_DIR: paths.deployDir,
    HERMES_HOME: paths.hermesHome || baseEnv.HERMES_HOME || '',
    HERMES_HOME_DIR: paths.hermesHome || baseEnv.HERMES_HOME_DIR || '',
    HERMES_WEB_UI_HOME: paths.webUiHome,
    HERMES_WEBUI_STATE_DIR: paths.webUiHome,
    UPLOAD_DIR: paths.uploadDir,
    HERMES_WEB_UI_STATE_DIR: paths.webUiHome,
    HERMES_WEB_UI_UPDATE_VERSION: manifest.version,
    HERMES_WEB_UI_UPDATE_TASK_ID: taskId,
    HERMES_WEB_UI_UPDATE_INSTALLER_SCRIPT_PATH: manifest.installerScriptPath || DEFAULT_INSTALLER_SCRIPT_PATH,
    HERMES_WEB_UI_UPDATE_INSTALLER_SCRIPT_SHA256: manifest.installerScriptSha256 || '',
    HERMES_WEB_UI_UPDATE_MANIFEST_ENV_JSON: JSON.stringify(manifest.environment || {}),
    HERMES_WEB_UI_UPDATE_AUTO_INSTALL_DEPENDENCIES: 'false',
    HERMES_WEB_UI_UPDATE_INCLUDE_AGENT_UPGRADE: 'false',
  }
}

export function buildDevicePackageInstallCommand(
  script: string,
  manifest: DevicePackageManifest,
  artifactPath: string,
  resolveCommand?: CommandResolver,
): { command: string; args: string[] } {
  return buildShellScriptCommand(
    script,
    [
    '--package', artifactPath,
    '--version', manifest.version,
    ],
    'Device package installer script',
    resolveCommand,
  )
}

export function buildDevicePackageReconcileCommand(
  script: string,
  manifest: DevicePackageManifest,
  resolveCommand?: CommandResolver,
): { command: string; args: string[] } {
  return buildShellScriptCommand(
    script,
    [
      '--reconcile-env-only',
      '--version', manifest.version,
    ],
    'Device package reconcile script',
    resolveCommand,
  )
}
