/** Choosing a server filesystem destination requires trusted write access. */
export function canChooseMediaOutputPath(state: {
  user?: { role?: string }
  serverTokenAuth?: boolean
}): boolean {
  return state.user?.role === 'super_admin' || state.serverTokenAuth === true
}
