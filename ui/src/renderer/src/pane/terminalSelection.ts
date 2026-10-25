// The focused pane's terminal selection for surfaces outside the terminal, read
// through the same `term.getSelection()` copy and search use. Each mounted
// TerminalPane registers its reader and unmount removes it.

type SelectionReader = () => string

/** What a thread's "Quote selection" shows for a pane: its name, and whether its grid is on screen. */
export interface SelectionSource {
  name: () => string
  hidden: () => boolean
}

const readers = new Map<number, { read: SelectionReader; source?: SelectionSource }>()

export function registerTerminalSelection(session: number, read: SelectionReader, source?: SelectionSource): () => void {
  const entry = { read, source }
  readers.set(session, entry)
  return () => {
    if (readers.get(session) === entry) readers.delete(session)
  }
}

export function terminalSelection(session: number | null): string {
  if (session === null) return ''
  return readers.get(session)?.read() ?? ''
}

export interface QuotableSelection {
  session: number
  name: string
  text: string
}

/** Terminal panes of the visible grid that hold a non-empty selection, read now. */
export function quotableSelections(): QuotableSelection[] {
  const out: QuotableSelection[] = []
  for (const [session, { read, source }] of readers) {
    if (!source || source.hidden()) continue
    const text = read()
    if (text.trim() !== '') out.push({ session, name: source.name(), text })
  }
  return out
}
