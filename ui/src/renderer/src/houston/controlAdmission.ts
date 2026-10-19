// The daemon refuses control work past its limits with `error.context =
// "control_admission:<type>[:<dir|request>]"` (bare "control_admission" names nothing).
// A refused request never replies, so a client tracking it settles it from this context.

const PREFIX = 'control_admission'

export interface ControlAdmissionRefusal {
  /** The refused message type, or null when the daemon did not name it. */
  kind: string | null
  /** The `dir` or `request` id the refused message carried; a directory may contain ':'. */
  target: string | null
}

export function parseControlAdmission(context: string | null | undefined): ControlAdmissionRefusal | null {
  if (context === PREFIX) return { kind: null, target: null }
  if (!context?.startsWith(`${PREFIX}:`)) return null
  const rest = context.slice(PREFIX.length + 1)
  const split = rest.indexOf(':')
  return split < 0
    ? { kind: rest, target: null }
    : { kind: rest.slice(0, split), target: rest.slice(split + 1) }
}

// Requests the renderer sends in bursts on connect and on every spawn, each with its
// own retry or timeout. A refusal of one is expected under load and is not an
// operator-visible failure, so it raises no toast and no pane's operation claims it.
const BACKGROUND_KINDS: ReadonlySet<string> = new Set([
  'git_branch',
  'git_status',
  'pr_status',
  'pr_status_batch',
  'worktree_cleanup_status',
])

export function isBackgroundAdmissionRefusal(context: string | null | undefined): boolean {
  const refusal = parseControlAdmission(context)
  return refusal !== null && refusal.kind !== null && BACKGROUND_KINDS.has(refusal.kind)
}
