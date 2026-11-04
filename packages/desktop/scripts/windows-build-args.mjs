// NSIS does not select an architecture from a shared latest.yml. Build each
// Windows architecture separately, with native dependencies from that runner.
export function windowsBuildArgs(args, platform = process.platform, arch = process.arch) {
  const windows = args.some(arg => ['--win', '-w', '--windows'].includes(arg) || arg.startsWith('--win='))
  const otherPlatform = args.some(arg => /^(--mac|--linux|-m|-l)(=|$)/.test(arg))
  if (!windows && (platform !== 'win32' || otherPlatform)) return args
  if (otherPlatform) throw new Error('Build Windows separately from macOS/Linux to isolate its update channel')
  const architectures = ['x64', 'arm64', 'ia32'].filter(value => args.includes(`--${value}`))
  const target = architectures[0] || arch
  if (architectures.length > 1 || !['x64', 'arm64'].includes(target)) {
    throw new Error('Build Windows with one architecture: --x64 or --arm64')
  }
  if (args.some(arg => arg.startsWith('--config.publish.channel'))) {
    throw new Error('Windows update channels are selected by architecture')
  }
  return [...args, ...(architectures.length ? [] : [`--${target}`]),
    ...(target === 'arm64' ? ['--config.publish.channel=latest-arm64'] : [])]
}
