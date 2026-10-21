import { useContext } from 'react'
import { DiffSplitCell, DiffSplitRow, DiffSplitCode, DiffSectionHeader, DiffFindText } from '../ui/Diff'
import { pairDiffLines, type NumberedDiffLine } from './splitDiff'
import { DiffFindContext, type DiffMarksLookup } from './diffFind'
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

function displayText(line: string, kind: DiffLineKind): string {
  return kind === 'add' || kind === 'del' || kind === 'ctx' ? line.slice(1) : line
}

/** The line texts DiffBody renders for `patch`, in order; find matches index into these. */
export function diffFindLines(patch: string): string[] {
  if (patch.trim().length === 0) return []
  return diffBodyLines(patch).map((line) => displayText(line, lineKind(line)))
}

const TRUNCATED_NOTE = '… patch truncated at 512 KiB — review locally'

function PlainDiff({ lines, truncated, marks }: { lines: string[]; truncated: boolean; marks: ((line: number) => ReturnType<DiffMarksLookup>) | null }): React.JSX.Element {
  if (marks === null) return <DiffPlainText>{lines.join('\n')}{truncated ? `\n${TRUNCATED_NOTE}` : ''}</DiffPlainText>
  return (
    <DiffPlainText>
      {lines.map((line, i) => {
        const text = displayText(line, lineKind(line))
        return <span key={i}>{i > 0 ? '\n' : ''}{line.slice(0, line.length - text.length)}<DiffFindText text={text} marks={marks(i)} /></span>
      })}
      {truncated ? `\n${TRUNCATED_NOTE}` : ''}
    </DiffPlainText>
  )
}

export function DiffBody({ patch, truncated, split = false, findKey }: { patch: string; truncated: boolean; split?: boolean; findKey?: string }): React.JSX.Element {
  const lookup = useContext(DiffFindContext)
  const marks = lookup && findKey !== undefined ? (line: number) => lookup(findKey, line) : null
  if (patch.trim().length === 0) return <DiffPlainText>No textual diff for this file.</DiffPlainText>
  const lines = diffBodyLines(patch)
  // Above this, one <div> per line makes the DOM too heavy; fall back to a plain <pre>.
  if (lines.length > 4000) return <PlainDiff lines={lines} truncated={truncated} marks={marks} />
  let oldLine = 0
  let newLine = 0
  const numbered: NumberedDiffLine[] = lines.map((line, index) => {
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
    return { kind, text: displayText(line, kind), oldNumber, newNumber, index }
  })
  if (truncated) numbered.push({ kind: 'meta', text: TRUNCATED_NOTE, oldNumber: null, newNumber: null })
  const lineMarks = (line: NumberedDiffLine | null): ReturnType<DiffMarksLookup> => (marks && line?.index !== undefined ? marks(line.index) : undefined)
  if (split) return <DiffSplitCode>
    {pairDiffLines(numbered).map((row, i) => 'header' in row
      ? <DiffSectionHeader key={i} kind={row.header.kind}><DiffFindText text={row.header.text} marks={lineMarks(row.header)} /></DiffSectionHeader>
      : <DiffSplitRow key={i}>
        {(['old', 'new'] as const).map((side) => {
          const line = row[side]
          const number = side === 'old' ? line?.oldNumber : line?.newNumber
          // A context line fills both cells; only the new side carries the current-match mark.
          const found = lineMarks(line)
          const shown = found && side === 'old' && line?.kind === 'ctx' ? { ...found, active: null } : found
          return <DiffSplitCell key={side} side={side} kind={line?.kind ?? 'ctx'} filler={!line} number={number ?? null}>
            <DiffGutter>{line?.kind === 'add' ? '+' : line?.kind === 'del' ? '−' : ''}</DiffGutter>
            <DiffLineText>{line?.text ? <DiffFindText text={line.text} marks={shown} /> : ' '}</DiffLineText>
          </DiffSplitCell>
        })}
      </DiffSplitRow>)}
  </DiffSplitCode>
  return <DiffCode>
    {numbered.map((line, i) => <DiffLine key={i} kind={line.kind} data-old-line={line.oldNumber ?? undefined} data-new-line={line.newNumber ?? undefined}>
      <span data-line-number="old" aria-hidden>{line.oldNumber ?? ''}</span>
      <span data-line-number="new" aria-hidden>{line.newNumber ?? ''}</span>
      <DiffGutter>{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}</DiffGutter>
      <DiffLineText>{line.text ? <DiffFindText text={line.text} marks={lineMarks(line)} /> : ' '}</DiffLineText>
    </DiffLine>)}
  </DiffCode>
}
