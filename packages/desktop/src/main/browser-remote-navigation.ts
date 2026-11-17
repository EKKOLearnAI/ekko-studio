import { isTrustedDesktopAppUrl } from './window-open-policy'

/** Both local and remote Studio use the authenticated main renderer relay. */
export function browserRelayDocument(frameUrl: string, studioUrl: string | null, mainFrame: boolean): string {
  if (!mainFrame || !studioUrl || !isTrustedDesktopAppUrl(frameUrl, studioUrl)) {
    throw new Error('Desktop browser sharing requires the main Studio document')
  }
  return studioUrl
}

/** Router/hash and child-frame changes do not replace the consented document. */
export function revokesRemoteBrowserGrant(inPlace: boolean, mainFrame: boolean): boolean {
  return mainFrame && !inPlace
}
