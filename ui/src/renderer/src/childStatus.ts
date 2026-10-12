import { askedOrchestrator, attentionLabel, attentionStatus } from './sessionAttention'
import { isLive, type SessionInfo } from './houston/client'

export const CHILD_GROUPS = ['Needs you', 'Waiting on orchestrator', 'Working', 'Stalled', 'Idle', 'Status unavailable', 'Settled'] as const

export function classifyChild(info: SessionInfo): { group: typeof CHILD_GROUPS[number]; word: string; dot: 'Needs input' | 'Asked orchestrator' | 'Working' | 'Idle' | 'Done' | 'Failed' | 'Ended' | 'Stalled' | 'Result staged' | null } {
  if (!isLive(info.state)) {
    const dot = info.delegation?.state === 'done' ? 'Done' : info.delegation?.state === 'failed' ? 'Failed' : 'Ended'
    return { group: 'Settled', word: dot.toLowerCase(), dot }
  }
  if (attentionStatus(info) === 'needs-input') return { group: 'Needs you', word: 'needs input', dot: 'Needs input' }
  if (askedOrchestrator(info)) return { group: 'Waiting on orchestrator', word: attentionLabel(info), dot: 'Asked orchestrator' }
  if (info.delegation?.result_staged) return { group: 'Idle', word: 'result staged', dot: 'Result staged' }
  if (info.delegation?.state === 'done' || info.delegation?.state === 'failed') return { group: 'Idle', word: info.delegation.state, dot: info.delegation.state === 'done' ? 'Done' : 'Failed' }
  if (info.delegation?.stalled) return { group: 'Stalled', word: 'stalled', dot: 'Stalled' }
  if (info.status === 'working') return { group: 'Working', word: 'working', dot: 'Working' }
  if (info.status === 'idle') return { group: 'Idle', word: 'idle', dot: 'Idle' }
  return { group: 'Status unavailable', word: 'unavailable', dot: null }
}

export function childGroup(info: SessionInfo): typeof CHILD_GROUPS[number] {
  return classifyChild(info).group
}

export function childStateWord(info: SessionInfo): string {
  return classifyChild(info).word
}

export function childSummary(children: readonly SessionInfo[]): string {
  const counts = new Map<typeof CHILD_GROUPS[number], number>()
  let done = 0
  let failed = 0
  for (const child of children) {
    const group = childGroup(child)
    counts.set(group, (counts.get(group) ?? 0) + 1)
    if (group === 'Settled') {
      if (child.delegation?.state === 'failed') failed++
      else done++
    }
  }
  const labels = [
    ['Needs you', 'needs you'], ['Waiting on orchestrator', 'waiting on orchestrator'],
    ['Stalled', 'stalled'], ['Idle', 'idle'], ['Status unavailable', 'status unavailable'],
  ] as const
  const optional = labels.filter(([group]) => counts.has(group)).map(([group, label]) => `${counts.get(group)} ${label}`)
  return ['children', ...optional, `${counts.get('Working') ?? 0} working`, `${done} done`, `${failed} failed`].join(' · ')
}
