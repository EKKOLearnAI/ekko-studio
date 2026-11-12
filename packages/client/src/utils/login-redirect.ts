const DEFAULT_LOGIN_REDIRECT = '/person'

export function resolveLoginRedirect(value: unknown): string {
  const redirect = typeof value === 'string' ? value : ''
  return redirect.startsWith('/') && !redirect.startsWith('//')
    ? redirect
    : DEFAULT_LOGIN_REDIRECT
}
