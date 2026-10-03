// The focused pane's terminal selection for surfaces outside the terminal, read
// through the same `term.getSelection()` copy and search use. Each mounted
// TerminalPane registers its reader and unmount removes it.

type SelectionReader = () => string

const readers = new Map<number, SelectionReader>()

export function registerTerminalSelection(session: number, read: SelectionReader): () => void {
  readers.set(session, read)
  return () => {
    if (readers.get(session) === read) readers.delete(session)
  }
}

export function terminalSelection(session: number | null): string {
  if (session === null) return ''
  return readers.get(session)?.() ?? ''
}
