import type { ChangeRow } from './changes'

export function changeListKeyDown(
  rows: ChangeRow[],
  selected: string | null,
  setSelected: (path: string) => void,
  select: (path: string) => void,
  stageToggle: (row: ChangeRow) => void
): ((event: React.KeyboardEvent) => void) {
  return (event) => {
    if (rows.length === 0) return
    const index = rows.findIndex((row) => row.path === selected)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next = event.key === 'ArrowDown'
        ? Math.min(rows.length - 1, index + 1)
        : Math.max(0, index - 1)
      setSelected(rows[next === -1 ? 0 : next].path)
      return
    }
    if (event.key === 'Enter' && index >= 0) {
      event.preventDefault()
      select(rows[index].path)
      return
    }
    if ((event.key === 's' || event.key === 'S') && index >= 0 && !event.metaKey && !event.ctrlKey) {
      event.preventDefault()
      stageToggle(rows[index])
    }
  }
}
