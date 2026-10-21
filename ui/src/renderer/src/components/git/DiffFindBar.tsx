import { TerminalFindButton, TerminalFindInput, TerminalFindStrip } from '../ui/TerminalFind'
import { FindStripCount, FindStripToggle } from '../ui/FindStripParts'
import { Tooltip } from '../ui/Tooltip'
import { Icon } from '../ui/Icon'
import { IconArrowDown, IconArrowUp, IconClose } from '../icons'
import { findCountLabel } from './diffFind'
import type { DiffFindController } from './useDiffFind'

const TRUNCATED_HINT = 'The patch was truncated at the byte cap; only the loaded part is searched.'

export function DiffFindBar({ find }: { find: DiffFindController }): React.JSX.Element | null {
  if (!find.open) return null
  const count = findCountLabel(find.result, find.active, find.term)
  const partial = find.truncated && find.term.length > 0
  const total = find.result.matches.length
  return (
    <TerminalFindStrip>
      <TerminalFindInput
        ref={find.inputRef}
        autoFocus
        aria-label="Find in diff"
        data-testid="diff-find-input"
        placeholder="find in diff…"
        value={find.term}
        onChange={(event) => find.setTerm(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Enter') {
            event.preventDefault()
            find.step(event.shiftKey ? -1 : 1)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            find.close()
          }
        }}
        spellCheck={false}
      />
      {partial ? (
        <Tooltip label={TRUNCATED_HINT}>
          <FindStripCount data-testid="diff-find-count">{count} · partial</FindStripCount>
        </Tooltip>
      ) : (
        <FindStripCount data-testid="diff-find-count">{count}</FindStripCount>
      )}
      <Tooltip label="Match case">
        <FindStripToggle pressed={find.caseSensitive} aria-label="Match case" data-testid="diff-find-case" onClick={find.toggleCase}>Aa</FindStripToggle>
      </Tooltip>
      <Tooltip label="Previous (Shift+Enter)">
        <TerminalFindButton aria-label="Previous match" disabled={total === 0} onClick={() => find.step(-1)}>
          <Icon glyph={IconArrowUp} role="ui" />
        </TerminalFindButton>
      </Tooltip>
      <Tooltip label="Next (Enter)">
        <TerminalFindButton aria-label="Next match" disabled={total === 0} onClick={() => find.step(1)}>
          <Icon glyph={IconArrowDown} role="ui" />
        </TerminalFindButton>
      </Tooltip>
      <Tooltip label="Close (Esc)">
        <TerminalFindButton aria-label="Close find" data-testid="diff-find-close" onClick={find.close}>
          <Icon glyph={IconClose} role="ui" />
        </TerminalFindButton>
      </Tooltip>
    </TerminalFindStrip>
  )
}
