import { useMemo } from 'react'
import { Chip, StatusGlyph } from './ui'
import type { SessionInfo } from '../houston/client'
import { needsUserInput } from '../sessionAttention'

/** With the rail hidden, the titlebar is the only place left to say a pane is waiting; the chip focuses the longest-waiting one. */
export function TitlebarNeedsYou({ sessions, railHidden, onFocusPane }: {
  sessions: ReadonlyMap<number, SessionInfo>
  railHidden: boolean
  onFocusPane: (id: number) => void
}): React.JSX.Element | null {
  const needsYou = useMemo(
    () => [...sessions.values()]
      .filter((session) => needsUserInput(session) && !session.hidden)
      .sort((a, b) => (a.status_since_ms ?? 0) - (b.status_since_ms ?? 0)),
    [sessions],
  )
  if (!railHidden || needsYou.length === 0) return null
  return (
    <span data-testid="titlebar-needs-you">
      <Chip
        variant="choice"
        icon={<StatusGlyph state="needs" />}
        label={`${needsYou.length} needs you`}
        onClick={() => onFocusPane(needsYou[0].id)}
      />
    </span>
  )
}
