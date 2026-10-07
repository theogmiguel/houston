import { DiffCode, DiffGutter, DiffLine, DiffLineText, DiffPlainText, type DiffLineKind } from '../ui'

export function lineKind(line: string): DiffLineKind {
  if (line.startsWith('@@')) return 'hunk'
  if (
    line.startsWith('diff --git') ||
    line.startsWith('index ') ||
    line.startsWith('+++') ||
    line.startsWith('---') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file') ||
    line.startsWith('rename ') ||
    line.startsWith('similarity ') ||
    line.startsWith('\\ No newline')
  )
    return 'meta'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'ctx'
}

export function diffBodyLines(patch: string): string[] {
  const lines = patch.split('\n')
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'))
  return firstHunk < 0 ? lines : lines.slice(firstHunk)
}

export function DiffBody({ patch, truncated }: { patch: string; truncated: boolean }): React.JSX.Element {
  const lines = diffBodyLines(patch)
  // Above this, one <div> per line makes the DOM too heavy; fall back to a plain <pre>.
  if (lines.length > 4000)
    return (
      <DiffPlainText>
        {lines.join('\n')}
        {truncated ? '\n… patch truncated at 512 KiB — review locally' : ''}
      </DiffPlainText>
    )
  let oldLine = 0
  let newLine = 0
  return (
    <DiffCode>
      {lines.map((line, i) => {
        const kind = lineKind(line)
        let oldNumber: number | null = null
        let newNumber: number | null = null
        if (kind === 'hunk') {
          const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
          if (match) {
            oldLine = Number(match[1])
            newLine = Number(match[2])
          }
        } else if (kind === 'ctx') {
          oldNumber = oldLine
          newNumber = newLine
          oldLine += 1
          newLine += 1
        } else if (kind === 'del') {
          oldNumber = oldLine
          oldLine += 1
        } else if (kind === 'add') {
          newNumber = newLine
          newLine += 1
        }
        return (
          <DiffLine key={i} kind={kind} data-old-line={oldNumber ?? undefined} data-new-line={newNumber ?? undefined}>
            <span data-line-number="old" aria-hidden>{oldNumber ?? ''}</span>
            <span data-line-number="new" aria-hidden>{newNumber ?? ''}</span>
            <DiffGutter>
              {kind === 'add' ? '+' : kind === 'del' ? '−' : ''}
            </DiffGutter>
            <DiffLineText>{(kind === 'add' || kind === 'del' ? line.slice(1) : line) || ' '}</DiffLineText>
          </DiffLine>
        )
      })}
      {truncated && (
        <DiffLine kind="meta">
          <span data-line-number="old" aria-hidden />
          <span data-line-number="new" aria-hidden />
          <DiffGutter />
          <DiffLineText>… patch truncated at 512 KiB — review locally</DiffLineText>
        </DiffLine>
      )}
    </DiffCode>
  )
}
