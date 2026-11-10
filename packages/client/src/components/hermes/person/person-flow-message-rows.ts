import type { PersonFlow } from '@/api/person'
import type { MessageSelectionRow } from '../chat/message-selection'

export type PersonFlowMessageRow = MessageSelectionRow & {flow?:PersonFlow}
const cardTimestamp = (flow:PersonFlow) => flow.timeline_at ?? flow.updated_at ?? flow.created_at ?? 0

/** Cards are display rows; they never enter model context or message deletion groups. */
export function personFlowMessageRows(rows:MessageSelectionRow[],flows:PersonFlow[],hasMoreBefore:boolean):PersonFlowMessageRow[] {
  const first = rows.find(row => row.messages.length)?.messages[0]?.timestamp ?? 0
  const cards = [...new Map(flows.map(flow => [flow.id,flow])).values()]
    .filter(flow => !hasMoreBefore || cardTimestamp(flow) >= first)
    .sort((a,b) => cardTimestamp(a)-cardTimestamp(b) || a.id.localeCompare(b.id))
  const result:PersonFlowMessageRow[] = []
  let index = 0
  const append = (flow:PersonFlow) => result.push({id:`person-flow:${flow.id}`,messages:[],flow})
  for (const row of rows) {
    while (index < cards.length && cardTimestamp(cards[index]) < (row.messages[0]?.timestamp ?? 0)) append(cards[index++])
    result.push(row)
  }
  while (index < cards.length) append(cards[index++])
  return result
}
