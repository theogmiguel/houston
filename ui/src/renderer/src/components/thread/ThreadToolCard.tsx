import { memo, useState } from 'react'
import { IconFileDiff, IconFileText, IconGlobe, IconMessageSquare, IconPencil, IconPlug, IconSearch, IconSparkles, IconSquareTerminal, IconTaskStatusTodo, IconUsers, IconWrench, type IconComponent } from '../icons'
import { DiffCode, DiffGutter, DiffLine, DiffLineText } from '../ui/Diff'
import { Button } from '../ui/Button'
import { ThreadApprovalCard, ThreadApprovalNote, ThreadCaption, ThreadCodeBlock, ThreadDiffFrame, ThreadLineCounts, ThreadToolSection, ThreadWorkRow, type ThreadToolState } from '../ui/Thread'
import { parseToolInput, replacementDiff, toolSummary, writeDiff, type DiffRow, type ThreadItem } from '../../thread/threadModel'
import { displayTarget, summaryOf, toolVerb } from '../../thread/threadTurns'
import type { ToolKind } from '../../thread/threadTypes'

type ToolItem = Extract<ThreadItem, { kind: 'tool' }>
type ApprovalItem = Extract<ThreadItem, { kind: 'approval' }>

const INPUT_CAP_NOTE = 'Input cut at 8 KiB by Houston.'
const OUTPUT_CAP_NOTE = 'Output cut at 16 KiB by Houston.'

const TOOL_GLYPH: Record<ToolKind, IconComponent> = {
  read: IconFileText,
  search: IconSearch,
  web: IconGlobe,
  command: IconSquareTerminal,
  edit: IconFileDiff,
  write: IconPencil,
  todo: IconTaskStatusTodo,
  question: IconMessageSquare,
  plan: IconSparkles,
  task: IconUsers,
  mcp: IconPlug,
  other: IconWrench
}

function stateOf(item: ToolItem): ThreadToolState {
  if (item.result) return item.result.isError ? 'error' : 'done'
  return item.settled ? 'unfinished' : 'running'
}

function DiffRows({ rows }: { rows: readonly DiffRow[] }): React.JSX.Element {
  return (
    <ThreadDiffFrame>
      <DiffCode>
        {rows.map((row, i) => (
          <DiffLine key={i} kind={row.kind}>
            <DiffGutter>{row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ''}</DiffGutter>
            <DiffLineText>{row.text || ' '}</DiffLineText>
          </DiffLine>
        ))}
      </DiffCode>
    </ThreadDiffFrame>
  )
}

function editRows(name: string, input: Record<string, unknown>): DiffRow[][] | null {
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
  if (name === 'Write') {
    const content = text(input.content)
    return content === null ? null : [writeDiff(content)]
  }
  if (name === 'Edit') {
    const before = text(input.old_string)
    const after = text(input.new_string)
    return before === null || after === null ? null : [replacementDiff(before, after)]
  }
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    const diffs = input.edits.flatMap((edit: unknown) => {
      const fields = edit !== null && typeof edit === 'object' ? edit as Record<string, unknown> : {}
      const before = text(fields.old_string)
      const after = text(fields.new_string)
      return before === null || after === null ? [] : [replacementDiff(before, after)]
    })
    return diffs.length > 0 ? diffs : null
  }
  return null
}

function prettyInput(input: string): string {
  const parsed = parseToolInput(input)
  return parsed === null ? input : JSON.stringify(parsed, null, 2)
}

function OutputSection({ item }: { item: ToolItem }): React.JSX.Element | null {
  const result = item.result
  if (!result) return null
  return (
    <ThreadToolSection label={result.isError ? 'Error' : 'Output'}>
      <ThreadCodeBlock tone={result.isError ? 'stop' : 'secondary'}>{result.output || '(no output)'}</ThreadCodeBlock>
      {result.truncated && <ThreadCaption>{OUTPUT_CAP_NOTE}</ThreadCaption>}
    </ThreadToolSection>
  )
}

function ToolBody({ item }: { item: ToolItem }): React.JSX.Element {
  const input = parseToolInput(item.input)
  const capNote = item.inputTruncated ? <ThreadCaption>{INPUT_CAP_NOTE}</ThreadCaption> : null
  if (item.name === 'Bash' && input !== null && typeof input.command === 'string') {
    return <>
      <ThreadToolSection label="Command"><ThreadCodeBlock>{input.command}</ThreadCodeBlock></ThreadToolSection>
      {typeof input.description === 'string' && <ThreadCaption>{input.description}</ThreadCaption>}
      {capNote}
      <OutputSection item={item} />
    </>
  }
  const diffs = input === null ? null : editRows(item.name, input)
  if (diffs !== null && input !== null) {
    return <>
      {typeof input.file_path === 'string' && <ThreadCaption>{input.file_path}{input.replace_all === true ? ' · every occurrence' : ''}</ThreadCaption>}
      {diffs.map((rows, i) => <DiffRows key={i} rows={rows} />)}
      {capNote}
      {item.result?.isError ? <OutputSection item={item} /> : null}
    </>
  }
  return <>
    {input === null && item.summary?.target ? <ThreadCaption>{item.summary.target}</ThreadCaption> : null}
    {item.input !== '' && <ThreadToolSection label="Input"><ThreadCodeBlock>{prettyInput(item.input)}</ThreadCodeBlock></ThreadToolSection>}
    {capNote}
    <OutputSection item={item} />
  </>
}

function formatKiB(bytes: number): string {
  return `${Math.max(1, Math.ceil(bytes / 1024)).toLocaleString()} KiB`
}

/** Bytes of the request's input the card does not show; Allow still approves them. */
export function hiddenInputBytes(item: Pick<ApprovalItem, 'input' | 'inputTruncated' | 'inputBytes'>): number {
  if (!item.inputTruncated) return 0
  return Math.max(0, item.inputBytes - new TextEncoder().encode(item.input).length)
}

/** A held permission request: the tool's input as its tool card shows it, then Allow / Deny. */
export const ThreadApprovalRow = memo(function ThreadApprovalRow({ item, answering, connected, onAnswer }: {
  item: ApprovalItem
  answering: boolean
  connected: boolean
  onAnswer: (requestId: string, allow: boolean) => void
}): React.JSX.Element {
  const asTool: ToolItem = { kind: 'tool', key: item.key, name: item.name, input: item.input, inputTruncated: false, summary: null, result: null, settled: true }
  const hidden = hiddenInputBytes(item)
  const locked = answering || !connected
  return (
    <ThreadApprovalCard
      name={item.name}
      summary={toolSummary(item.input)}
      state={item.state}
      reason={item.reason}
      status={answering ? 'Sending your answer…' : connected ? undefined : 'Reconnecting to the daemon'}
      actions={<>
        <Button data-testid="thread-approval-deny" variant="secondary" size="sm" disabled={locked} onClick={() => onAnswer(item.requestId, false)}>Deny</Button>
        <Button data-testid="thread-approval-allow" variant="primary" size="sm" disabled={locked} onClick={() => onAnswer(item.requestId, true)}>
          {hidden > 0 ? `Allow (${formatKiB(hidden)} not shown)` : 'Allow'}
        </Button>
      </>}
    >
      {item.state === 'pending' ? <>
        <ToolBody item={asTool} />
        {hidden > 0 && <ThreadApprovalNote>{formatKiB(hidden)} more input is not shown; Allow approves it too.</ThreadApprovalNote>}
      </> : null}
    </ThreadApprovalCard>
  )
})

export const ThreadToolRow = memo(function ThreadToolRow({ item, cwd }: { item: ToolItem; cwd?: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const summary = summaryOf(item)
  const counted = summary.kind === 'edit' || summary.kind === 'write'
  return (
    <ThreadWorkRow
      glyph={TOOL_GLYPH[summary.kind]}
      verb={toolVerb(item.name, summary.kind)}
      target={displayTarget(summary.target, cwd)}
      result={counted ? <ThreadLineCounts added={summary.added ?? null} removed={summary.removed ?? null} /> : undefined}
      state={stateOf(item)}
      open={open}
      onToggle={() => setOpen((value) => !value)}
    >
      <ToolBody item={item} />
    </ThreadWorkRow>
  )
})
