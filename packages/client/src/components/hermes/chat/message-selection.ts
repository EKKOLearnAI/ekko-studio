import type { Message } from '@/stores/hermes/chat'
import type { MessageSelectionGroup } from '@/api/studio/sessions'

export interface MessageSelectionRow {
  id: string
  messages: Message[]
  group?: MessageSelectionGroup
}

export function buildMessageSelectionRows(messages: Message[], groups: MessageSelectionGroup[]): MessageSelectionRow[] {
  const byMessage = new Map(groups.flatMap(group => group.messageIds.map(id => [id, group] as const)))
  const byRun = new Map(groups.filter(group => group.runMarker).map(group => [group.runMarker!, group]))
  const rows: MessageSelectionRow[] = []
  const grouped = new Map<number, MessageSelectionRow>()
  for (const message of messages) {
    const group = byMessage.get(message.storedMessageId ?? Number(message.id))
      || (message.runMarker && message.role !== 'user' && message.role !== 'command' ? byRun.get(message.runMarker) : undefined)
      || (message.toolMessages?.map(tool => byMessage.get(tool.storedMessageId ?? Number(tool.id))).find(Boolean))
    if (!group) {
      rows.push({ id: message.id, messages: [message] })
      continue
    }
    let row = grouped.get(group.id)
    if (!row) {
      row = { id: `selection:${group.id}`, messages: [], group }
      grouped.set(group.id, row)
      rows.push(row)
    }
    row.messages.push(message)
  }
  return rows
}
