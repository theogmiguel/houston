export const HANDOFF_PACKET_MAX_CHARS = 40_000

export const HANDOFF_ASK_DEFAULT = 'Continue from here.'

export const HANDOFF_TRIMMED_NOTE = '(Earlier conversation trimmed.)'

// Trims to the cap off the END (newest output) when the dialog opens, before
// `buildHandoffPacket` budgets, so editing the ask never re-walks a megabyte of
// scrollback. `+ 1` keeps an exactly-full conversation reading as trimmed.
export function clampConversation(conversation: string): string {
  const cap = HANDOFF_PACKET_MAX_CHARS + 1
  return conversation.length <= cap ? conversation : conversation.slice(conversation.length - cap)
}

export interface HandoffPacketInput {
  sourceLabel: string
  title: string
  ask: string
  conversation: string
}

export interface HandoffPacket {
  text: string
  trimmed: boolean
  chars: number
}

export function handoffCharCount(chars: number): string {
  return `${(chars / 1000).toFixed(1)}k characters`
}

function tailWithinBudget(conversation: string, budget: number): string | null {
  if (conversation.length <= budget) return null
  if (budget <= 0) return ''
  const cut = conversation.slice(conversation.length - budget)
  const nl = cut.indexOf('\n')
  return nl === -1 ? cut : cut.slice(nl + 1)
}

export function buildHandoffPacket({
  sourceLabel,
  title,
  ask,
  conversation
}: HandoffPacketInput): HandoffPacket {
  const askText = ask.trim() === '' ? HANDOFF_ASK_DEFAULT : ask.trim()
  const head =
    `You are picking up a conversation from ${sourceLabel} ("${title}").\n\n` +
    `${askText}\n` +
    'Do not recap unless asked. The prior conversation is below.\n\n' +
    '---\n' +
    '# Prior conversation\n'
  const body = conversation.replace(/\s+$/, '')
  const budget = HANDOFF_PACKET_MAX_CHARS - head.length - HANDOFF_TRIMMED_NOTE.length - 2
  const tail = tailWithinBudget(body, budget)
  const text =
    tail === null ? head + body + '\n' : `${head}${HANDOFF_TRIMMED_NOTE}\n${tail.replace(/^\n+/, '')}\n`
  return { text, trimmed: tail !== null, chars: text.length }
}
