import { PluginError } from './errors'

// Match the original input, before URL normalization can hide dot segments or credentials.
const githubRepositoryUrl = /^https:\/\/github\.com\/([a-z\d][a-z\d-]{0,38})\/([\w.-]+?)(?:\.git)?\/?$/i
const resolutionError = (message: string) => new PluginError(message, 'PLUGIN_SOURCE_RESOLVE', 422)

export async function resolveGithubPluginSource(source: string): Promise<string> {
  const match = githubRepositoryUrl.exec(source)
  if (!match || ['.', '..'].includes(match[2])) return source
  const repository = `${match[1]}/${match[2]}`
  try {
    // Without sha, GitHub lists commits from the repository's default branch.
    const response = await fetch(`https://api.github.com/repos/${repository}/commits?per_page=1`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Ekko-Studio-Plugin-Installer' },
      credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15_000),
    })
    if (response.status === 404) throw resolutionError('GitHub repository not found or not publicly accessible; check the repository URL or use a local plugin directory')
    if (response.status === 403 || response.status === 429) throw resolutionError('GitHub access denied or API rate limit reached; try again later or use a local plugin directory')
    if (response.status === 409) throw resolutionError('GitHub repository has no commits to install')
    if (!response.ok) throw resolutionError('Unable to resolve GitHub repository; check network access and try again')
    const commits: unknown = await response.json()
    const commit = Array.isArray(commits) ? commits[0]?.sha : undefined
    if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) throw resolutionError('GitHub did not return a valid commit; try again later or use a local plugin directory')
    return `github:${repository}#${commit}`
  } catch (error) {
    if (error instanceof PluginError) throw error
    throw resolutionError('Unable to resolve GitHub repository; check network access and try again')
  }
}
