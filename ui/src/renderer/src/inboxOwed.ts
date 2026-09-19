import type { InboxRow, SessionInfo } from './houston/client'
import type { NoticeSeverity } from './components/noticeSeverity'

export const RESOLVABLE_INBOX_KINDS: ReadonlySet<string> = new Set([
  'needs_input',
  'exited',
  'stalled'
])

export function severityForInboxKind(kind: string): NoticeSeverity {
  if (kind === 'needs_input') return 'needs-input'
  if (kind === 'exited' || kind === 'stalled') return 'error'
  return 'info'
}

export function inboxFromLabel(
  row: InboxRow,
  sessions: ReadonlyMap<number, SessionInfo>
): string {
  if (row.from_session == null) return 'Houston'
  const pane = sessions.get(row.from_session)
  const name = pane?.codename || `#${row.from_session}`
  const role = pane?.delegation?.role
  return role ? `${role} (${name})` : name
}

export function inboxTargetLabel(
  row: InboxRow,
  sessions: ReadonlyMap<number, SessionInfo>
): string | null {
  if (row.original_to == null) return null
  return sessions.get(row.original_to)?.codename || `#${row.original_to}`
}

export function inboxWhyLabel(reason: string | null | undefined): string | null {
  if (reason == null || reason.trim() === '') return null
  const tag = reason.split(':')[0]?.trim() ?? ''
  switch (tag) {
    case 'parent_dead':
      return 'parent gone'
    case 'attempts': {
      const n = reason.match(/\d+/)?.[0]
      return n ? `${n} pastes failed` : 'pastes failed'
    }
    case 'partial':
      return 'half-pasted'
    case 'late':
      return 'arrived late'
    case 'lane_full':
      return 'lane full'
    case 'backlog':
      return 'over the cap'
    default:
      return tag || reason
  }
}

export function owedInboxRows(rows: Iterable<InboxRow>): InboxRow[] {
  return [...rows]
    .filter((r) => r.resolved_at == null)
    .sort((a, b) => Number(a.created_at - b.created_at) || Number(a.id - b.id))
}

export function owedInboxSummary(inboxRows: ReadonlyMap<bigint, InboxRow>): {
  owed: InboxRow[]
  correctedBy: Map<string, bigint>
  unread: number
  needsInput: number
} {
  const owed = owedInboxRows(inboxRows.values())
  return {
    owed,
    correctedBy: correctedByMap(owed),
    unread: owed.filter((r) => r.delivered_at == null).length,
    needsInput: owed.filter((r) => r.kind === 'needs_input').length
  }
}

export function mergeInboxRows(
  prev: ReadonlyMap<bigint, InboxRow>,
  workspace: string,
  rows: InboxRow[]
): Map<bigint, InboxRow> {
  const next = new Map(prev)
  for (const [id, row] of next) if (row.workspace === workspace) next.delete(id)
  for (const row of rows) next.set(row.id, row)
  return next
}

export function applyInboxChanged(
  prev: ReadonlyMap<bigint, InboxRow>,
  row: InboxRow
): Map<bigint, InboxRow> {
  const next = new Map(prev)
  if (row.to_session === 0) next.set(row.id, row)
  else next.delete(row.id)
  return next
}

export function owedByWorkspace(rows: InboxRow[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of rows)
    if (r.delivered_at == null) out[r.workspace] = (out[r.workspace] ?? 0) + 1
  return out
}

export function isBellEmpty(noticeCount: number, owedCount: number): boolean {
  return noticeCount === 0 && owedCount === 0
}

export function requestInboxForWorkspaces(
  inboxList: (workspace: string) => void,
  workspaces: ReadonlyArray<{ path: string }>
): void {
  for (const w of workspaces) inboxList(w.path)
}

export function correctedByMap(rows: InboxRow[]): Map<string, bigint> {
  const map = new Map<string, bigint>()
  for (const r of rows) if (r.corrects != null) map.set(String(r.corrects), r.id)
  return map
}

export function inboxJumpTarget(
  row: InboxRow,
  sessions: ReadonlyMap<number, SessionInfo>
): { workspace: string; session: number } | null {
  if (row.original_to != null && sessions.has(row.original_to))
    return { workspace: row.workspace, session: row.original_to }
  if (row.from_session != null && sessions.has(row.from_session))
    return { workspace: row.workspace, session: row.from_session }
  return null
}
