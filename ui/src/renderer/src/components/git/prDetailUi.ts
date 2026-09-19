import type {
  PrDetail,
  PrDiffSide,
  PrReaction,
  PrReactionCount,
  PrReviewDraft,
  PrReviewer,
  PrReviewerCandidate,
  PrStack,
  PrStackHead
} from '../../houston/client'

// The eight reactions GitHub has, in its own order, with the words it uses.
// The glyph is the reaction itself, not decoration: it is what a reader clicks.
export const REACTION_ORDER: readonly PrReaction[] = [
  'thumbs_up',
  'thumbs_down',
  'laugh',
  'hooray',
  'confused',
  'heart',
  'rocket',
  'eyes'
] as const

export const REACTION_GLYPH: Record<PrReaction, string> = {
  thumbs_up: '👍',
  thumbs_down: '👎',
  laugh: '😄',
  hooray: '🎉',
  confused: '😕',
  heart: '❤️',
  rocket: '🚀',
  eyes: '👀'
}

export const REACTION_LABEL: Record<PrReaction, string> = {
  thumbs_up: 'Thumbs up',
  thumbs_down: 'Thumbs down',
  laugh: 'Laugh',
  hooray: 'Hooray',
  confused: 'Confused',
  heart: 'Heart',
  rocket: 'Rocket',
  eyes: 'Eyes'
}

export function reviewerKey(r: PrReviewer | PrReviewerCandidate): string {
  return `${r.kind}:${r.id}`
}

/** A team is named as one, so `core` and a user called `core` never look alike. */
export function reviewerName(r: PrReviewer | PrReviewerCandidate): string {
  return r.kind === 'team' ? `${r.id} (team)` : r.id
}

export function requestedReviewers(reviewers: readonly PrReviewer[]): string {
  return reviewers.map((r) => reviewerName(r)).join(', ')
}

// The remote patch parsed into files and numbered lines; inline drafts are
// addressed by (path, side, line) straight from the parser.

export interface PrDiffLine {
  kind: 'meta' | 'hunk' | 'add' | 'del' | 'ctx'
  text: string
  oldLine: number | null
  newLine: number | null
  /** The side a draft on this line anchors to, and the line number it names. */
  side: PrDiffSide | null
  line: number | null
}

export interface PrDiffFile {
  path: string
  previousPath: string | null
  additions: number
  deletions: number
  lines: PrDiffLine[]
}

const META_PREFIXES = [
  'diff --git',
  'index ',
  '+++',
  '---',
  'new file',
  'deleted file',
  'rename ',
  'similarity ',
  '\\ No newline'
]

function lineKind(line: string): 'meta' | 'hunk' | 'add' | 'del' | 'ctx' {
  if (line.startsWith('@@')) return 'hunk'
  if (META_PREFIXES.some((p) => line.startsWith(p))) return 'meta'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'ctx'
}

function filePathFromHeader(line: string, prefix: string): string | null {
  const rest = line.slice(prefix.length).trim()
  if (rest.length === 0 || rest === '/dev/null') return null
  return rest.replace(/^[ab]\//, '')
}

function pathFromGitHeader(line: string): string | null {
  const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
  return match ? match[2] : null
}

/** Every file of a unified patch, in the order it carries them. */
export function parsePrDiff(patch: string): PrDiffFile[] {
  const files: PrDiffFile[] = []
  let current: PrDiffFile | null = null
  let oldLine = 0
  let newLine = 0
  const lines = patch.split('\n')
  // A trailing newline yields one empty tail line; it is not patch content.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  for (const raw of lines) {
    const kind = lineKind(raw)
    if (kind === 'meta' && raw.startsWith('diff --git')) {
      const path = pathFromGitHeader(raw) ?? ''
      current = { path, previousPath: null, additions: 0, deletions: 0, lines: [] }
      files.push(current)
      current.lines.push({ kind: 'meta', text: raw, oldLine: null, newLine: null, side: null, line: null })
      continue
    }
    if (current === null) {
      current = { path: '', previousPath: null, additions: 0, deletions: 0, lines: [] }
      files.push(current)
    }
    if (kind === 'hunk') {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
      if (match) {
        oldLine = Number.parseInt(match[1], 10)
        newLine = Number.parseInt(match[2], 10)
      }
      current.lines.push({ kind: 'hunk', text: raw, oldLine: null, newLine: null, side: null, line: null })
      continue
    }
    if (kind === 'meta') {
      if (raw.startsWith('--- ')) {
        const previous = filePathFromHeader(raw, '---')
        if (previous !== null && current.path !== previous) current.previousPath = previous
        else if (previous !== null && current.path === '') current.path = previous
      }
      if (raw.startsWith('+++ ')) {
        const path = filePathFromHeader(raw, '+++')
        if (path !== null && current.path === '') current.path = path
      }
      current.lines.push({ kind: 'meta', text: raw, oldLine: null, newLine: null, side: null, line: null })
      continue
    }
    if (kind === 'add') {
      current.additions += 1
      current.lines.push({ kind: 'add', text: raw, oldLine: null, newLine, side: 'right', line: newLine })
      newLine += 1
      continue
    }
    if (kind === 'del') {
      current.deletions += 1
      current.lines.push({ kind: 'del', text: raw, oldLine, newLine: null, side: 'left', line: oldLine })
      oldLine += 1
      continue
    }
    current.lines.push({ kind: 'ctx', text: raw, oldLine, newLine, side: 'right', line: newLine })
    oldLine += 1
    newLine += 1
  }
  return files
}

export function draftKey(d: PrReviewDraft): string {
  return `${d.path}:${d.side}:${d.line}`
}

export function draftLabel(d: PrReviewDraft): string {
  const side = d.side === 'left' ? 'old' : 'new'
  return `${d.path} · ${side} line ${d.line}`
}

export function reactionCount(counts: readonly PrReactionCount[], content: PrReaction): number {
  return counts.find((c) => c.content === content)?.count ?? 0
}

export function hasReacted(counts: readonly PrReactionCount[], content: PrReaction): boolean {
  return counts.some((c) => c.content === content && c.reacted)
}

// What GitHub's own answer allows. The daemon re-reads the same facts before
// every write; these exist so a control never invites a refusal.

export type PrActionKey =
  | 'ready'
  | 'draft'
  | 'close'
  | 'reopen'
  | 'update_branch'
  | 'enable_auto_merge'
  | 'disable_auto_merge'
  | 'revert'
  | 'approve_workflows'

const NO_PERMISSIONS = 'permissions could not be read — refresh'

export function actionDisabledReason(detail: PrDetail, action: PrActionKey): string | null {
  const viewer = detail.viewer
  if (!viewer) return NO_PERMISSIONS
  switch (action) {
    case 'ready':
    case 'draft':
    case 'close':
    case 'reopen':
      return viewer.can_update ? null : 'GitHub says you may not update this pull request'
    case 'update_branch':
      if (!viewer.can_write) return 'you do not have write access to this repository'
      return viewer.can_update_branch ? null : 'the branch has nothing to update'
    case 'enable_auto_merge':
    case 'disable_auto_merge':
    case 'revert':
    case 'approve_workflows':
      return viewer.can_write ? null : 'you do not have write access to this repository'
  }
}

/** A review an author may send: GitHub refuses their own approval or request. */
export function verdictsFor(detail: PrDetail): readonly ('comment' | 'approve' | 'request_changes')[] {
  return detail.viewer?.did_author ? (['comment'] as const) : (['comment', 'approve', 'request_changes'] as const)
}

/** The layers a merge of `number` would take: every open layer up to it. */
export function stackMergeHeads(stack: PrStack, number: number): PrStackHead[] {
  const target = stack.layers.findIndex((l) => l.number === number)
  if (target < 0) return []
  return stack.layers
    .slice(0, target + 1)
    .filter((l) => l.state !== 'merged')
    .map((l) => ({ number: l.number, head_sha: l.head_sha ?? '' }))
}

export function stackMergeRefusal(stack: PrStack, number: number): string | null {
  const heads = stackMergeHeads(stack, number)
  if (heads.length === 0) return 'this pull request is not a layer of the stack'
  if (heads.some((h) => h.head_sha === '')) return 'a layer reports no head revision to pin'
  const target = stack.layers.find((l) => l.number === number)
  if (target === undefined) return 'this pull request is not a layer of the stack'
  if (target.state !== 'open') return 'this layer is not open'
  const affected = stack.layers.slice(0, stack.layers.indexOf(target) + 1)
  if (affected.some((l) => l.state === 'open' && l.is_draft)) {
    return 'a layer of the stack is still a draft'
  }
  if (affected.some((l) => l.state === 'closed')) return 'a layer of the stack is closed'
  return null
}

export function resolveDisabledReason(detail: PrDetail): string | null {
  const viewer = detail.viewer
  if (!viewer) return NO_PERMISSIONS
  return viewer.can_write || viewer.did_author
    ? null
    : 'resolving needs write access or authorship'
}
