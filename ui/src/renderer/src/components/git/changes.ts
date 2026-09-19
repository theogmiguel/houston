import type { GitFileStatus } from '../../houston/client'
import type { PrChecks } from '../../houston/generated/PrChecks'
import { isSensitivePath } from '../../git/review'

export type ChangeTag = 'staged' | 'unstaged' | 'untracked' | 'conflict' | 'blocked'

export type ChangeGroup = 'conflicted' | 'staged' | 'unstaged' | 'untracked'

export const GROUP_LABEL: Record<ChangeGroup, string> = {
  conflicted: 'Conflicted',
  staged: 'Staged',
  unstaged: 'Unstaged',
  untracked: 'Untracked'
}

export const GROUP_ORDER: readonly ChangeGroup[] = [
  'conflicted',
  'staged',
  'unstaged',
  'untracked'
] as const

export interface ChangeRow {
  path: string
  dir: string
  name: string
  state: GitFileStatus['status']
  tag: ChangeTag
  group: ChangeGroup
  added: number | null
  deleted: number | null
  blocked: boolean
  key: string
}

export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf('/')
  return i >= 0 ? { dir: path.slice(0, i + 1), name: path.slice(i + 1) } : { dir: '', name: path }
}

export function tagFor(f: GitFileStatus): ChangeTag {
  if (f.is_sensitive || isSensitivePath(f.path)) return 'blocked'
  if (f.status === 'conflicted') return 'conflict'
  if (f.status === 'untracked') return 'untracked'
  return f.staged ? 'staged' : 'unstaged'
}

export function groupFor(f: GitFileStatus): ChangeGroup {
  if (f.status === 'conflicted') return 'conflicted'
  if (f.status === 'untracked') return 'untracked'
  return f.staged ? 'staged' : 'unstaged'
}

export function toRow(f: GitFileStatus): ChangeRow {
  const { dir, name } = splitPath(f.path)
  const group = groupFor(f)
  return {
    path: f.path,
    dir,
    name,
    state: f.status,
    tag: tagFor(f),
    group,
    added: f.added ?? null,
    deleted: f.deleted ?? null,
    blocked: f.is_sensitive || isSensitivePath(f.path),
    key: `${group}:${f.path}`
  }
}

export function groupRows(files: GitFileStatus[]): { group: ChangeGroup; rows: ChangeRow[] }[] {
  const byGroup = new Map<ChangeGroup, Map<string, ChangeRow>>()
  for (const f of files) {
    const row = toRow(f)
    const bucket = byGroup.get(row.group) ?? new Map<string, ChangeRow>()
    if (!bucket.has(row.path)) bucket.set(row.path, row)
    byGroup.set(row.group, bucket)
  }
  return GROUP_ORDER.filter((g) => (byGroup.get(g)?.size ?? 0) > 0).map((g) => ({
    group: g,
    rows: [...(byGroup.get(g) as Map<string, ChangeRow>).values()].sort((a, b) =>
      a.path.localeCompare(b.path)
    )
  }))
}

export function flatRows(files: GitFileStatus[]): ChangeRow[] {
  return groupRows(files).flatMap((g) => g.rows)
}

export function stagedCount(files: GitFileStatus[]): number {
  const paths = new Set<string>()
  for (const f of files) if (groupFor(f) === 'staged') paths.add(f.path)
  return paths.size
}

export function stageActionFor(row: ChangeRow): 'stage' | 'unstage' | null {
  if (row.blocked) return null
  return row.group === 'staged' ? 'unstage' : 'stage'
}

export function discardKindFor(row: ChangeRow): 'staged' | 'unstaged' | 'untracked' | null {
  if (row.blocked) return null
  if (row.group === 'untracked') return 'untracked'
  return row.group === 'staged' ? 'staged' : 'unstaged'
}

export function discardConfirmMessage(row: ChangeRow): string {
  return row.group === 'untracked'
    ? `Delete ${row.path}? It is untracked, so git has no copy — this cannot be undone.`
    : `Discard your changes to ${row.path}? This cannot be undone.`
}

export function discardConfirmLabel(row: ChangeRow): string {
  return row.group === 'untracked' ? 'Delete file' : 'Discard changes'
}

export function scopeLabels(defaultBase: string | null): { working: string; branch: string } {
  return {
    working: 'Working tree',
    branch: defaultBase ? `Branch vs ${defaultBase}` : 'Branch vs base'
  }
}

export function branchChipLabel(
  branch: string | null,
  ahead: number,
  behind: number
): string {
  const name = branch ?? 'detached'
  const parts: string[] = []
  if (ahead > 0) parts.push(`↑${ahead}`)
  if (behind > 0) parts.push(`↓${behind}`)
  return parts.length > 0 ? `${name} · ${parts.join(' ')}` : name
}

// `git_stage` with an empty path list means "stage everything" (`git add -A`)
// daemon-side, so these must always return explicit paths — never `[]` for
// "nothing to do" — or a bulk action would sweep blocked paths in with the rest.
export function stageAllPaths(files: GitFileStatus[]): string[] {
  const out: string[] = []
  for (const f of files) {
    const row = toRow(f)
    if (row.group === 'staged' || row.blocked) continue
    if (!out.includes(row.path)) out.push(row.path)
  }
  return out
}

export function unstageAllPaths(files: GitFileStatus[]): string[] {
  const out: string[] = []
  for (const f of files) {
    const row = toRow(f)
    if (row.group !== 'staged' || row.blocked) continue
    if (!out.includes(row.path)) out.push(row.path)
  }
  return out
}

export function bulkLabelFor(group: ChangeGroup): 'Stage all' | 'Unstage all' {
  return group === 'staged' ? 'Unstage all' : 'Stage all'
}

export function groupBulkPaths(rows: ChangeRow[]): string[] {
  return rows.filter((r) => !r.blocked).map((r) => r.path)
}

export function groupBulkDisabledReason(group: ChangeGroup): string {
  return `Every file under ${GROUP_LABEL[group]} is a blocked path — its contents were never shown`
}

export function pushLabel(ahead: number): string {
  return ahead > 0 ? `Push ↑${ahead}` : 'Push'
}

export const PR_CHECKS_LABEL: Record<PrChecks, string> = {
  none: 'no checks',
  running: 'checks running',
  passing: 'checks passing',
  failing: 'checks failing'
}

export function prChecksLabel(checks: PrChecks): string {
  return PR_CHECKS_LABEL[checks] ?? 'no checks'
}

export const PR_DECISION_LABEL: Record<string, string> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes requested',
  REVIEW_REQUIRED: 'review requested'
}

export function prDecisionLabel(decision: string | null): string | null {
  if (decision === null) return null
  return PR_DECISION_LABEL[decision] ?? null
}

export type ChangesPaneState = 'idle' | 'not-a-repo' | 'error' | 'loading' | 'empty' | 'filled'

export function paneStateFor(
  repoDir: string | null,
  statusError: string | null,
  rowCount: number,
  statusLoaded: boolean
): ChangesPaneState {
  if (repoDir === null) return 'idle'
  if (statusError !== null && statusError.includes('not a git repository')) return 'not-a-repo'
  if (statusError !== null) return 'error'
  if (!statusLoaded) return 'loading'
  return rowCount === 0 ? 'empty' : 'filled'
}

export function pullDisabledReason(upstream: string | null, behind: number): string | null {
  if (upstream === null) return 'This branch has no upstream yet'
  if (behind === 0) return 'Nothing to pull — the branch matches its upstream'
  return null
}

// A branch with no upstream still pushes: the push publishes it and sets the
// upstream. Only an already-tracking branch with nothing ahead is a no-op.
export function pushDisabledReason(
  upstream: string | null,
  ahead: number,
  pushing: boolean
): string | null {
  if (pushing) return 'Pushing…'
  if (upstream !== null && ahead === 0) return 'Nothing to push — the branch matches its upstream'
  return null
}
