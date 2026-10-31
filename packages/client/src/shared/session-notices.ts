/** Rows a paginated history page returned from storage; virtual session notices are not stored rows. */
export function storedMessageCount(messages: ReadonlyArray<{ studio_notice?: unknown }>): number {
  return messages.filter(message => !message.studio_notice).length
}
