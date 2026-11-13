import { homedir } from 'os'
import { join } from 'path'
import { getHermesHome } from '../../public/config'

let resolveHermesHome: () => string = () => getHermesHome() || join(homedir(), '.hermes')

/** Bootstrap supplies the concrete Agent adapter without coupling Studio to it. */
export function configureUpdateRuntime(dependencies: { getHermesHome: () => string }): void {
  resolveHermesHome = dependencies.getHermesHome
}

export function getHermesUpdateHome(): string {
  return resolveHermesHome()
}
