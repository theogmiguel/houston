import type { RailAgentRow } from '../../rail/railCardModel'
import type { PanePhase } from '../../../houston/generated/PanePhase'
import { formatAge } from '../../tasks/format'
import { IconClose } from '../../icons'
import { Icon } from '../Icon'
import { Tooltip } from '../Tooltip'

/** The newest note an agent in the grid wrote on its own pane. */
export type RailNote = {
  session: number
  pane: string
  text: string
  phase: PanePhase | null
  atMs: number
}

// Kept out of the boot-loaded card model: only the lazily loaded rail row reads notes.
export function newestNote(agents: readonly RailAgentRow[]): RailNote | null {
  return agents.reduce<RailNote | null>((newest, { session, leading }) => {
    const n = session.note
    if (!n || (newest && newest.atMs >= n.at_ms)) return newest
    return { session: session.id, pane: leading, text: n.text, phase: n.phase ?? null, atMs: n.at_ms }
  }, null)
}

const PHASE_LABEL: Record<PanePhase, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done'
}

/** The newest note an agent in the grid wrote with `pane_note`: one line, its age and Clear. */
export function GridRailNoteLine({ note, now, onClear }: { note: RailNote; now: number; onClear?: (session: number) => void }): React.JSX.Element {
  const phase = note.phase ? PHASE_LABEL[note.phase] : null
  return (
    <div data-testid="grid-note" className="flex min-w-0 items-center gap-[5px] px-1 text-[length:var(--tr-text-xs)] leading-4 text-[var(--text-secondary)]">
      <Tooltip label={`${note.pane}: ${note.text}`} className="min-w-0 flex-1">
        <span className="block truncate">
          {phase && <span data-testid="grid-note-phase" className="text-[var(--text-muted)]">{phase} · </span>}
          {note.text}
        </span>
      </Tooltip>
      <time className="flex-none tabular-nums text-[var(--text-muted)]">{formatAge(note.atMs, now)}</time>
      {onClear && (
        <Tooltip label="Clear note">
          <button
            type="button"
            data-testid="grid-note-clear"
            aria-label={`Clear the note from ${note.pane}`}
            className="flex size-4 flex-none items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--card-hover)] hover:text-[var(--text-primary)]"
            onClick={(event) => {
              event.stopPropagation()
              onClear(note.session)
            }}
          >
            <Icon glyph={IconClose} role="small" />
          </button>
        </Tooltip>
      )}
    </div>
  )
}
