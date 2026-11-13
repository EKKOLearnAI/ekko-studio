export type RunChatPetObserver = (
  profile: string | null | undefined,
  event: string,
  payload: Record<string, unknown>,
) => unknown

let observer: RunChatPetObserver | null = null

export function configureRunChatPetObserver(next: RunChatPetObserver): void {
  observer = next
}

export function observeRunChatPetEvent(
  profile: string | null | undefined,
  event: string,
  payload: Record<string, unknown>,
): unknown {
  return observer?.(profile, event, payload)
}
