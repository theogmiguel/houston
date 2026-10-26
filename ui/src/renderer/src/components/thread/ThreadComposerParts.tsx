import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { searchFilePaths } from '../../houston/bridge'
import { atMention, insertAtToken, menuToken, SLASH_GROUP_LABEL, slashRows, type MenuToken, type SlashGroup } from '../../thread/composerMenu'
import { excerptLabel, lineCount, quoteRefusal } from '../../thread/excerpts'
import type { ThreadCommands, ThreadExcerpt } from '../../thread/threadTypes'
import { quotableSelections, type QuotableSelection } from '../../pane/terminalSelection'
import { Notice } from '../ui/Notice'
import { ThreadComposerMenu, ThreadExcerptChip, ThreadExcerptChips, ThreadExcerptPreview, ThreadMenuGroup, ThreadMenuRow } from '../ui/Thread'

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

/** Paths under the session's directory for an `@` query, from the same index Quick Open reads; links are left out because Claude reads an `@` target without a permission prompt. */
function useAtSearch(root: string, token: MenuToken | null): { paths: string[]; loading: boolean; error: string | null } {
  const query = token?.trigger === '@' ? token.query : null
  const [state, setState] = useState<{ paths: string[]; loading: boolean; error: string | null }>({ paths: [], loading: false, error: null })
  useEffect(() => {
    if (query === null) return
    let live = true
    setState((current) => ({ ...current, loading: true, error: null }))
    const timer = window.setTimeout(() => {
      searchFilePaths(root, query, AT_RESULTS_MAX)
        .then((result) => { if (live) setState({ paths: result.items.filter((item) => item.symlink !== true).map((item) => item.path), loading: false, error: null }) })
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
        return (
          <Fragment key={entry.key}>
            {heading !== null && <ThreadMenuGroup>{heading}</ThreadMenuGroup>}
            <ThreadMenuRow
              id={`${id}-${index}`}
              active={index === active}
              name={entry.name}
              detail={entry.detail}
              action={entry.action}
              disabledReason={entry.disabledReason ?? null}
              onSelect={entry.run}
              onHover={() => onActive(index)}
            />
          </Fragment>
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


const NO_TERMINAL = 'This thread cannot open in a terminal from here'

/** Enter or Tab that picks the active row; an IME confirmation (key code 229 or composing) does not. */
function picksRow(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
  if (e.key === 'Tab') return true
  return e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229
}

export interface ComposerFields {
  text: string
  setText: (text: string) => void
  excerpts: readonly ThreadExcerpt[]
  setExcerpts: (excerpts: readonly ThreadExcerpt[]) => void
  setRefusal: (refusal: string | null) => void
}

/** The `/` and `@` menus and the Quote selection picker: rows, active row and caret. `onKey` says whether the menu used the key. */
export function useComposerMenus({ fields, commands, root, terminal, input }: {
  fields: ComposerFields
  commands: ThreadCommands | null
  root: string
  terminal?: { refusal: string | null; open: () => void }
  input: React.RefObject<HTMLTextAreaElement | null>
}): {
  menu: React.ReactNode
  open: boolean
  onKey: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean
  onEdit: (caret: number) => void
  onCaret: (caret: number) => void
  closePicker: () => void
  startQuote: () => void
} {
  const { text, setText, excerpts, setExcerpts, setRefusal } = fields
  const [caret, setCaret] = useState(0)
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [quoting, setQuoting] = useState<readonly QuotableSelection[] | null>(null)
  const pendingCaret = useRef<number | null>(null)
  useLayoutEffect(() => {
    const at = pendingCaret.current
    if (at === null || !input.current) return
    pendingCaret.current = null
    input.current.focus()
    input.current.setSelectionRange(at, at)
  })
  const actions: MenuActions = {
    insert: (token, insert) => {
      const next = insertAtToken(text, token, insert)
      setText(next.text)
      setCaret(next.caret)
      pendingCaret.current = next.caret
    },
    openInTerminal: () => terminal?.open(),
    terminalRefusal: terminal ? terminal.refusal : NO_TERMINAL
  }
  const typed = useComposerMenu({ text, caret, commands, root, actions })
  const tokenKey = typed.token ? `${typed.token.start}:${typed.token.trigger}` : null
  const quote = (selection: QuotableSelection): void => {
    setQuoting(null)
    const refused = quoteRefusal(excerpts, selection.text)
    setRefusal(refused)
    if (refused !== null) return
    setExcerpts([...excerpts, { source: selection.name, session: selection.session, text: selection.text }])
    pendingCaret.current = caret
  }
  const picker = quoting === null ? null : selectionEntries(quoting, quote)
  const open = picker !== null || (typed.token !== null && tokenKey !== dismissed && (typed.entries.length > 0 || typed.notice !== null))
  const entries = picker ?? typed.entries
  const activeIndex = Math.min(active, Math.max(0, entries.length - 1))
  const label = picker !== null ? 'Quote selection from' : typed.token?.trigger === '@' ? 'Files' : 'Commands'
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false
    if (e.key === 'Escape') {
      setQuoting(null)
      setDismissed(tokenKey)
      return true
    }
    if (entries.length === 0) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      setActive((activeIndex + (e.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length)
      return true
    }
    if (!picksRow(e)) return false
    const entry = entries[activeIndex]
    if (entry && !entry.disabledReason) {
      setActive(0)
      entry.run()
    }
    return true
  }
  const startQuote = (): void => {
    const selections = quotableSelections()
    const only = selections.length === 1 ? selections[0] : undefined
    if (only) return quote(only)
    if (selections.length === 0) return setRefusal('Nothing to quote: select text in a terminal pane of this grid first.')
    setActive(0)
    setQuoting(selections)
  }
  return {
    menu: open ? <ComposerMenu entries={entries} notice={picker === null ? typed.notice : null} active={activeIndex} onActive={setActive} label={label} /> : null,
    open,
    onKey,
    onEdit: (at) => {
      setCaret(at)
      setActive(0)
      setQuoting(null)
    },
    onCaret: setCaret,
    closePicker: () => setQuoting(null),
    startQuote
  }
}

/** A command Claude runs only in its terminal interface: the reason, and Open in terminal when the pane can switch now. */
export function CommandRefusal({ reason, terminal, onDismiss }: {
  reason: string
  terminal?: { refusal: string | null; open: () => void }
  onDismiss: () => void
}): React.JSX.Element {
  const openable = terminal !== undefined && terminal.refusal === null && reason.includes('runs only in a terminal pane')
  return (
    <Notice tone="danger" inset="compact-inline" action={openable ? { label: 'Open in terminal', onClick: () => terminal.open() } : { label: 'Dismiss', onClick: onDismiss }}>
      {`Not sent: ${reason}`}
    </Notice>
  )
}
