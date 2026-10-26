/** Public deployment prefix; root installs and Desktop keep their existing URLs. */
export function deploymentBasePath(): string {
  const base = import.meta.env.BASE_URL || '/'
  return base === '/' ? '' : base.replace(/\/$/, '')
}

export function deploymentUrl(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) return path
  const base = deploymentBasePath()
  if (!base || path === base || path.startsWith(`${base}/`)) return path
  return `${base}${path}`
}

/** Socket.IO namespaces must not include the deployment path. */
export function socketEndpoint(base: string, namespace: string): { url: string; path: string } {
  if (!base) return { url: namespace, path: '/socket.io' }
  const parsed = new URL(base, typeof window === 'undefined' ? 'http://localhost' : window.location.origin)
  return {
    url: `${parsed.origin}${namespace}`,
    path: `${parsed.pathname.replace(/\/$/, '')}/socket.io`,
  }
}
