import type { ChatEffort } from '../houston/generated/ChatEffort'

export type ChipOption<V> = {
  value: V
  title: string
  detail: string
  badge?: string
}

export const CHAT_EFFORTS: ChipOption<ChatEffort | null>[] = [
  { value: null, title: 'Automatic', detail: "The CLI's own default effort" },
  { value: 'low', title: 'Low', detail: 'Answers fast, thinks little' },
  { value: 'medium', title: 'Medium', detail: 'Balanced thinking' },
  { value: 'high', title: 'High', detail: 'Thinks before it answers' },
  { value: 'xhigh', title: 'Extra High', detail: 'Longest deliberation' },
  { value: 'max', title: 'Max', detail: 'The longest the CLI offers' }
]
