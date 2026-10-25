import { useEffect, useId, useState } from 'react'
import { searchFilePaths } from '../../houston/bridge'
import { atMention, menuToken, SLASH_GROUP_LABEL, slashRows, type MenuToken, type SlashGroup } from '../../thread/composerMenu'
import { excerptLabel, lineCount } from '../../thread/excerpts'
import type { ThreadCommands, ThreadExcerpt } from '../../thread/threadTypes'
import type { QuotableSelection } from '../../pane/terminalSelection'
import { ThreadComposerMenu, ThreadExcerptChip, ThreadExcerptChips, ThreadExcerptPreview, ThreadMenuGroup, ThreadMenuRow } from '../ui/Thread'
import { Tooltip } from '../ui/Tooltip'

/** One selectable menu row; `run` acts on it (insert text, open the terminal, quote a pane). */
export interface MenuEntry {
  key: string
  group: string
  name: string
  detail?: string
  action?: string
  /** Why the row cannot be chosen now; shown as its tooltip. */
  disabledReason?: string | null
  run: () => void
}

/** Matches requested from the app's file index per `@` query: enough to pick from, bounded like Quick Open. */
const AT_RESULTS_MAX = 50
const AT_SEARCH_DEBOUNCE_MS = 80

export interface MenuActions {
  /** Puts `insert` in place of the token. */
  insert: (token: MenuToken, insert: string) => void
  /** Moves the conversation to a terminal pane. */
  openInTerminal: () => void
  /** Why it cannot move now, or null. */
  terminalRefusal: string | null
}

const SLASH_DETAIL: Record<SlashGroup, string> = {
  houston: 'Continue this conversation in a terminal pane',
  skill: 'Skill',
  claude: 'Claude command, runs in this thread',
  terminal: 'Runs only in a terminal pane'
}

function slashEntries(commands: ThreadCommands | null, token: MenuToken, actions: MenuActions): MenuEntry[] {
  return slashRows(commands, token.query).map((row) => {
    const opens = row.group === 'houston' || row.group === 'terminal'
    return {
      key: `${row.group}:${row.name}`,
      group: SLASH_GROUP_LABEL[row.group],
      name: `/${row.name}`,
      detail: SLASH_DETAIL[row.group],
      action: opens ? 'Open in terminal' : undefined,
      disabledReason: opens ? actions.terminalRefusal : null,
      run: opens ? actions.openInTerminal : () => actions.insert(token, `/${row.name}`)
    }
  })
}

/** Paths under the session's directory for an `@` query, from the same index Quick Open reads. */
function useAtSearch(root: string, token: MenuToken | null): { paths: string[]; loading: boolean; error: string | null } {
  const query = token?.trigger === '@' ? token.query : null
  const [state, setState] = useState<{ paths: string[]; loading: boolean; error: string | null }>({ paths: [], loading: false, error: null })
  useEffect(() => {
    if (query === null) return
    let live = true
    setState((current) => ({ ...current, loading: true, error: null }))
    const timer = window.setTimeout(() => {
      searchFilePaths(root, query, AT_RESULTS_MAX)
        .then((result) => { if (live) setState({ paths: result.items.map((item) => item.path), loading: false, error: null }) })
        .catch((failure: unknown) => { if (live) setState({ paths: [], loading: false, error: failure instanceof Error ? failure.message : String(failure) }) })
    }, AT_SEARCH_DEBOUNCE_MS)
    return () => { live = false; window.clearTimeout(timer) }
  }, [root, query])
  return state
}

/** The menu's rows for the word under the caret, or none. `notice` explains an empty menu. */
export function useComposerMenu({ text, caret, commands, root, actions }: {
  text: string
  caret: number
  commands: ThreadCommands | null
  root: string
  actions: MenuActions
}): { token: MenuToken | null; entries: MenuEntry[]; notice: string | null } {
  const token = menuToken(text, caret)
  const at = useAtSearch(root, token)
  if (token === null) return { token, entries: [], notice: null }
  if (token.trigger === '/') {
    const entries = slashEntries(commands, token, actions)
    const listed = commands !== null && commands.commands.length + commands.skills.length + commands.terminal_only.length > 0
    return { token, entries, notice: listed ? null : 'Claude lists its commands and skills when this thread’s first message runs.' }
  }
  const entries = at.paths.map((path) => ({ key: `at:${path}`, group: 'Files', name: path, run: () => actions.insert(token, atMention(path)) }))
  const notice = at.error !== null ? `Files could not be listed: ${at.error}` : at.loading && entries.length === 0 ? 'Searching files…' : entries.length === 0 ? 'No file matches' : null
  return { token, entries, notice }
}

/** The pane picker for "Quote selection" when more than one pane holds a selection. */
export function selectionEntries(selections: readonly QuotableSelection[], quote: (selection: QuotableSelection) => void): MenuEntry[] {
  return selections.map((selection) => {
    const lines = lineCount(selection.text)
    return { key: `quote:${selection.session}`, group: 'Quote selection from', name: selection.name, detail: `${lines} ${lines === 1 ? 'line' : 'lines'}`, run: () => quote(selection) }
  })
}

export function ComposerMenu({ entries, notice, active, onActive, label }: {
  entries: readonly MenuEntry[]
  notice: string | null
  active: number
  onActive: (index: number) => void
  label: string
}): React.JSX.Element {
  const id = useId()
  let group: string | null = null
  return (
    <ThreadComposerMenu id={id} label={label}>
      {notice !== null && <ThreadMenuGroup>{notice}</ThreadMenuGroup>}
      {entries.map((entry, index) => {
        const heading = entry.group !== group ? entry.group : null
        group = entry.group
        const row = (
          <ThreadMenuRow
            id={`${id}-${index}`}
            active={index === active}
            name={entry.name}
            detail={entry.detail}
            action={entry.action}
            disabled={!!entry.disabledReason}
            onSelect={entry.run}
            onHover={() => onActive(index)}
          />
        )
        return (
          <div key={entry.key} className="contents">
            {heading !== null && <ThreadMenuGroup>{heading}</ThreadMenuGroup>}
            {entry.disabledReason ? <Tooltip label={entry.disabledReason} className="block">{row}</Tooltip> : row}
          </div>
        )
      })}
    </ThreadComposerMenu>
  )
}

/** Quoted selections as chips; one at a time expands to show its full text. */
export function ExcerptList({ excerpts, onRemove }: { excerpts: readonly ThreadExcerpt[]; onRemove?: (index: number) => void }): React.JSX.Element | null {
  const [open, setOpen] = useState<number | null>(null)
  if (excerpts.length === 0) return null
  const shown = open !== null ? excerpts[open] : undefined
  return (
    <>
      <ThreadExcerptChips>
        {excerpts.map((excerpt, index) => (
          <ThreadExcerptChip
            key={index}
            label={excerptLabel(excerpt)}
            expanded={open === index}
            onToggle={() => setOpen(open === index ? null : index)}
            onRemove={onRemove && (() => { setOpen(null); onRemove(index) })}
          />
        ))}
      </ThreadExcerptChips>
      {shown && <ThreadExcerptPreview>{shown.text}</ThreadExcerptPreview>}
    </>
  )
}

