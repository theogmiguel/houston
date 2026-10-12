import { DiffSplitCell, DiffSplitRow, DiffSplitCode, DiffSectionHeader } from '../ui/Diff'
import { pairDiffLines, type NumberedDiffLine } from './splitDiff'
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
  if (lines.at(-1) === '') lines.pop()
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'))
  return firstHunk < 0 ? lines : lines.slice(firstHunk)
}

export function DiffBody({ patch, truncated, split = false }: { patch: string; truncated: boolean; split?: boolean }): React.JSX.Element {
  if (patch.trim().length === 0) return <DiffPlainText>No textual diff for this file.</DiffPlainText>
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
  const numbered: NumberedDiffLine[] = lines.map((line) => {
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
    return { kind, text: kind === 'add' || kind === 'del' || kind === 'ctx' ? line.slice(1) : line, oldNumber, newNumber }
  })
  if (truncated) numbered.push({ kind: 'meta', text: '… patch truncated at 512 KiB — review locally', oldNumber: null, newNumber: null })
  if (split) return <DiffSplitCode>
    {pairDiffLines(numbered).map((row, i) => 'header' in row
      ? <DiffSectionHeader key={i} kind={row.header.kind}>{row.header.text}</DiffSectionHeader>
      : <DiffSplitRow key={i}>
        {(['old', 'new'] as const).map((side) => {
          const line = row[side]
          const number = side === 'old' ? line?.oldNumber : line?.newNumber
          return <DiffSplitCell key={side} side={side} kind={line?.kind ?? 'ctx'} filler={!line} number={number ?? null}>
            <DiffGutter>{line?.kind === 'add' ? '+' : line?.kind === 'del' ? '−' : ''}</DiffGutter>
            <DiffLineText>{line?.text || ' '}</DiffLineText>
          </DiffSplitCell>
        })}
      </DiffSplitRow>)}
  </DiffSplitCode>
  return <DiffCode>
    {numbered.map((line, i) => <DiffLine key={i} kind={line.kind} data-old-line={line.oldNumber ?? undefined} data-new-line={line.newNumber ?? undefined}>
      <span data-line-number="old" aria-hidden>{line.oldNumber ?? ''}</span>
      <span data-line-number="new" aria-hidden>{line.newNumber ?? ''}</span>
      <DiffGutter>{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}</DiffGutter>
      <DiffLineText>{line.text || ' '}</DiffLineText>
    </DiffLine>)}
  </DiffCode>
}
