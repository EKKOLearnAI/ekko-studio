// Newer Hermes releases keep package metadata at 0.0.0 and record their
// release identity in install-stamp.json instead of rewriting tracked source.
export function needsHermesInstallStamp(declaredVersion, source, hasStampWriter) {
  if (declaredVersion === source.version) return false
  if (declaredVersion === '0.0.0'
    && source.ref === `v${source.version}`
    && hasStampWriter) return true
  throw new Error(`Hermes version mismatch: expected ${source.version}, source declares ${declaredVersion}`)
}

export const hermesInstalledVersionScript = [
  'import importlib.metadata as metadata',
  'version = metadata.version("hermes-agent")',
  'if version == "0.0.0":',
  '    from hermes_cli.version_info import get_version_info',
  '    version = get_version_info().base_version',
  'print(version)',
].join('\n')
