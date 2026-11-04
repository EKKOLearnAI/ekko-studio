/** Router/hash and child-frame changes do not replace the consented document. */
export function revokesRemoteBrowserGrant(inPlace: boolean, mainFrame: boolean): boolean {
  return mainFrame && !inPlace
}
