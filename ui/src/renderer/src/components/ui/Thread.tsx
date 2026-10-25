import type { ReactNode, Ref, TextareaHTMLAttributes } from 'react'
import { IconBrain, IconCheck, IconChevronDown, IconChevronRight, IconFileDiff, IconFileText, IconInfo, IconSearch, IconShieldAlert, IconSquareTerminal, IconStopCircle, IconWrench, type IconComponent } from '../icons'
import { Button } from './Button'
import { Icon } from './Icon'
import { Prose } from './Prose'
import { WorkingSpinner } from './Spinner'
import { FOCUS_RING_ACCENT_INSET_45_CLS } from './shadowChrome'
import { Text } from './Text'

/** The thread pane body: a scrolling timeline over a docked composer, on the pane ground. */
export function ThreadSurface({ children }: { children: ReactNode }): React.JSX.Element {
  return <div data-testid="thread-surface" className="flex min-h-0 flex-1 flex-col bg-[var(--pane-bg)]">{children}</div>
}

export function ThreadScroll({ children, ref, onScroll }: { children: ReactNode; ref?: Ref<HTMLDivElement>; onScroll?: () => void }): React.JSX.Element {
  return (
    <div ref={ref} onScroll={onScroll} data-testid="thread-scroll" role="log" aria-label="Thread" aria-live="off" className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin] [overflow-anchor:none]">
      <div className="mx-auto flex w-full max-w-[var(--w-thread-column)] flex-col gap-[var(--space-3)] px-[var(--space-4)] py-[var(--space-4)]">{children}</div>
    </div>
  )
}

export function ThreadUserMessage({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div data-thread-item="user" className="flex justify-end">
      <Text as="div" size="body" weight="body" tone="primary" leading="chatMarkdown" className="max-w-[85%] whitespace-pre-wrap break-words rounded-[var(--tr-radius-card)] border border-[var(--border)] bg-[var(--card-bg)] px-[var(--space-3)] py-[var(--space-2)]">{children}</Text>
    </div>
  )
}

/** Assistant prose; `streaming` marks a block still receiving deltas (no motion, by design). */
export function ThreadAssistantBlock({ streaming, children }: { streaming: boolean; children: ReactNode }): React.JSX.Element {
  return <div data-thread-item="assistant" data-streaming={streaming || undefined} aria-busy={streaming || undefined} className="min-w-0">{children}</div>
}

/** Plain assistant text, for a block the Markdown chunk has not rendered yet. */
export function ThreadPlainText({ children }: { children: ReactNode }): React.JSX.Element {
  return <Prose variant="chat"><Text as="p" size="body" tone="primary" className="whitespace-pre-wrap break-words">{children}</Text></Prose>
}

export type ThreadToolState = 'running' | 'done' | 'error' | 'unfinished'

const TOOL_STATE_WORD: Record<ThreadToolState, string | null> = { running: 'Running', done: null, error: 'Failed', unfinished: 'No result' }

const WORK_ROW_CLS = `flex h-[var(--h-thread-work-row)] w-full min-w-0 items-center gap-[var(--space-1-5)] rounded-[var(--tr-radius-sm)] border-0 bg-transparent px-[var(--space-1)] text-left text-[var(--text-secondary)] focus-visible:outline-none ${FOCUS_RING_ACCENT_INSET_45_CLS}`
const WORK_ROW_HOVER_CLS = 'hover:bg-[var(--hover-fill)] hover:text-[var(--text-primary)]'

/** `+12 −3`, in the diff colours; a missing count is left out. */
export function ThreadLineCounts({ added, removed }: { added: number | null; removed: number | null }): React.JSX.Element | null {
  if (added === null && removed === null) return null
  return (
    <Text as="span" size="small" mono tabular className="flex-none">
      {added !== null && <span className="text-[var(--success)]">+{added}</span>}
      {added !== null && removed !== null && ' '}
      {removed !== null && <span className="text-[var(--danger)]">−{removed}</span>}
    </Text>
  )
}

/** One tool call as a 24 px row: verb, monospace target, and its result on the right; opens its details. */
export function ThreadWorkRow({ glyph = IconWrench, verb, target, result, state, open, onToggle, children }: {
  glyph?: IconComponent
  verb: string
  target: string
  /** Shown on the right once the call succeeded, for example line counts. */
  result?: ReactNode
  state: ThreadToolState
  open: boolean
  onToggle: () => void
  children?: ReactNode
}): React.JSX.Element {
  const word = TOOL_STATE_WORD[state]
  return (
    <div data-thread-item="tool" data-tool-state={state} className="flex min-w-0 flex-col gap-[var(--space-1)]">
      <button type="button" aria-expanded={open} onClick={onToggle} className={`${WORK_ROW_CLS} ${WORK_ROW_HOVER_CLS}`}>
        <Icon glyph={glyph} role="small" className={`flex-none ${state === 'error' ? 'text-[var(--stop)]' : 'text-[var(--text-faint)]'}`} />
        <Text as="span" size="small" weight="semibold" tone="secondary" className="flex-none">{verb}</Text>
        <Text as="span" size="small" tone="muted" mono className="min-w-0 flex-1 truncate">{target}</Text>
        {word ? <Text as="span" size="small" tone={state === 'error' ? 'stop' : state === 'running' ? 'info' : 'faint'} className="flex-none">{word}</Text> : result}
        <Icon glyph={open ? IconChevronDown : IconChevronRight} role="small" className="flex-none text-[var(--text-faint)]" />
      </button>
      {open && <div className="flex flex-col gap-[var(--space-2)] rounded-[var(--tr-radius-button)] border border-[var(--border)] bg-[var(--card-bg)] p-[var(--space-2)]">{children}</div>}
    </div>
  )
}

/** That Claude reasoned for one step, and for how long; `live` marks a block still streaming. */
export function ThreadReasoningRow({ label, live }: { label: string; live: boolean }): React.JSX.Element {
  return (
    <div data-thread-item="reasoning" data-live={live || undefined} className={WORK_ROW_CLS}>
      {live ? <WorkingSpinner label="Thinking" /> : <Icon glyph={IconBrain} role="small" className="flex-none text-[var(--text-faint)]" />}
      <Text as="span" size="small" tone="muted" className="min-w-0 flex-1 truncate">{label}</Text>
    </div>
  )
}

/** A settled turn's summary ("Worked for 2m 14s · Read 6 files"); its work rows follow it when open. */
export function ThreadTurnFold({ label, outcome, open, onToggle }: {
  label: string
  outcome: 'completed' | 'interrupted' | 'error'
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <div data-thread-item="turn" data-turn-outcome={outcome} className="flex min-w-0 items-center gap-[var(--space-2)]">
      <button type="button" aria-expanded={open} onClick={onToggle} className={`${WORK_ROW_CLS} ${WORK_ROW_HOVER_CLS} w-auto max-w-full flex-none`}>
        <Icon glyph={IconChevronDown} role="small" className={`flex-none text-[var(--text-faint)] motion-safe:transition-transform ${open ? 'rotate-0' : '-rotate-90'}`} />
        <Text as="span" size="small" tone={outcome === 'error' ? 'stop' : 'muted'} className="min-w-0 truncate">{label}</Text>
      </button>
      <div aria-hidden className="min-w-0 flex-1 border-t border-[var(--divider)]" />
    </div>
  )
}

export interface ThreadChangedFile {
  path: string
  glyph: IconComponent
  added: number
  removed: number
}

/** The files a turn changed, with line counts and a way to each file's diff. */
export function ThreadChangedFiles({ files, onOpen }: { files: readonly ThreadChangedFile[]; onOpen?: (path: string) => void }): React.JSX.Element {
  const added = files.reduce((sum, file) => sum + file.added, 0)
  const removed = files.reduce((sum, file) => sum + file.removed, 0)
  return (
    <section data-thread-item="changes" aria-label="Changed files" className="min-w-0 overflow-hidden rounded-[var(--tr-radius-button)] border border-[var(--border)] bg-[var(--card-bg)]">
      <div className="flex min-h-[var(--h-ctl)] items-center gap-[var(--space-2)] px-[var(--space-2)]">
        <Icon glyph={IconFileDiff} role="small" className="flex-none text-[var(--text-faint)]" />
        <Text as="span" size="small" weight="semibold" tone="primary" className="min-w-0 flex-1 truncate">{files.length === 1 ? 'Changed 1 file' : `Changed ${files.length} files`}</Text>
        <ThreadLineCounts added={added} removed={removed} />
      </div>
      <div className="border-t border-[var(--divider)] px-[var(--space-2)] py-[var(--space-1)]">
        <ul className="m-0 flex list-none flex-col p-0">
          {files.map((file) => (
            <li key={file.path} className="flex h-[var(--h-thread-work-row)] min-w-0 items-center gap-[var(--space-1-5)]">
              <Icon glyph={file.glyph} role="small" className="flex-none text-[var(--text-faint)]" />
              <Text as="span" size="small" tone="secondary" mono className="min-w-0 flex-1 truncate">{file.path}</Text>
              <ThreadLineCounts added={file.added} removed={file.removed} />
              {onOpen && <Button variant="ghost" size="sm" onClick={() => onOpen(file.path)}>Open diff</Button>}
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

export type ThreadApprovalState = 'pending' | 'allowed' | 'denied' | 'withdrawn'

const APPROVAL_WORD: Record<ThreadApprovalState, string> = { pending: 'Waiting for you', allowed: 'Allowed', denied: 'Denied', withdrawn: 'Not answered' }

/** Claude asks to run a tool: the request, its input and, while pending, the answers. */
/** A line under an approval card's input, wrapped so no word is left alone on a line. */
export function ThreadApprovalNote({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="div" size="small" tone="faint" className="[text-wrap:pretty]">{children}</Text>
}

export function ThreadApprovalCard({ name, summary, state, reason, status, actions, children }: {
  name: string
  summary: string
  state: ThreadApprovalState
  reason?: string | null
  /** Replaces the pending state's words, for example while an answer is on its way. */
  status?: string
  actions?: ReactNode
  children?: ReactNode
}): React.JSX.Element {
  const pending = state === 'pending'
  return (
    <section
      data-thread-item="approval"
      data-approval-state={state}
      aria-label={`Permission request: ${name}`}
      className={`min-w-0 overflow-hidden rounded-[var(--tr-radius-button)] border bg-[var(--card-bg)] ${pending ? 'border-[var(--warn)]' : 'border-[var(--border)]'}`}
    >
      <div className="flex min-h-[var(--h-ctl)] min-w-0 items-center gap-[var(--space-2)] px-[var(--space-2)]">
        <Icon glyph={pending ? IconShieldAlert : state === 'allowed' ? IconCheck : IconStopCircle} role="small" className={`flex-none ${pending ? 'text-[var(--warn)]' : 'text-[var(--text-faint)]'}`} />
        <Text as="span" size="small" tone="secondary" className="flex-none">Claude asks to use</Text>
        <Text as="span" size="small" weight="semibold" tone="primary" className="flex-none">{name}</Text>
        <Text as="span" size="small" tone="muted" mono className="min-w-0 flex-1 truncate">{summary}</Text>
      </div>
      {children && <div className="flex flex-col gap-[var(--space-2)] border-t border-[var(--divider)] p-[var(--space-2)]">{children}</div>}
      <div className="flex min-w-0 items-center gap-[var(--space-2)] border-t border-[var(--divider)] px-[var(--space-2)] py-[var(--space-1-5)]">
        <Text as="div" role="status" size="small" tone={pending ? 'secondary' : 'muted'} className="min-w-0 flex-1 break-words [text-wrap:pretty]">
          {pending ? status ?? APPROVAL_WORD.pending : APPROVAL_WORD[state]}{!pending && reason ? ` · ${reason}` : ''}
        </Text>
        {pending && actions}
      </div>
    </section>
  )
}

/** The strip above a thread's timeline: session-wide controls such as the permission mode. */
export function ThreadHeaderBar({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-none items-center gap-[var(--space-2)] border-b border-[var(--divider)] px-[var(--space-4)] py-[var(--space-1-5)]">
      <div className="mx-auto flex w-full max-w-[var(--w-thread-column)] min-w-0 items-center gap-[var(--space-2)]">{children}</div>
    </div>
  )
}

export function ThreadToolSection({ label, children }: { label: string; children: ReactNode }): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-[var(--space-1)]">
      <Text as="div" size="label" weight="label" tone="faint">{label}</Text>
      {children}
    </div>
  )
}

/** Tool input or output as written: monospace, wrapped, scrolling past a bounded height. */
export function ThreadCodeBlock({ tone = 'secondary', children }: { tone?: 'secondary' | 'stop'; children: ReactNode }): React.JSX.Element {
  return <Text as="pre" size="small" tone={tone} mono className="m-0 max-h-[var(--h-thread-code-max)] overflow-auto whitespace-pre-wrap break-words rounded-[var(--tr-radius-sm)] bg-[var(--tool-code-bg)] p-[var(--space-2)]">{children}</Text>
}

export function ThreadDiffFrame({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="max-h-[var(--h-thread-code-max)] overflow-auto rounded-[var(--tr-radius-sm)] bg-[var(--tool-code-bg)]">{children}</div>
}

export function ThreadCaption({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="div" size="small" tone="faint">{children}</Text>
}

export function ThreadNotice({ tone = 'muted', children }: { tone?: 'muted' | 'stop'; children: ReactNode }): React.JSX.Element {
  return (
    <div data-thread-item="notice" role="note" className="flex items-start gap-[var(--space-1-5)]">
      <Icon glyph={IconInfo} role="small" className={`flex-none ${tone === 'stop' ? 'text-[var(--stop)]' : 'text-[var(--text-faint)]'}`} />
      <Text as="div" size="small" tone={tone === 'stop' ? 'stop' : 'muted'} className="min-w-0 whitespace-pre-wrap break-words">{children}</Text>
    </div>
  )
}

export const THREAD_STOPPED_COPY = 'Stopped · Claude will not remember this partial answer'

export function ThreadStoppedMarker(): React.JSX.Element {
  return (
    <div data-thread-item="stopped" role="note" className="flex items-center gap-[var(--space-1-5)]">
      <Icon glyph={IconStopCircle} role="small" className="flex-none text-[var(--warn)]" />
      <Text as="span" size="small" tone="secondary">{THREAD_STOPPED_COPY}</Text>
    </div>
  )
}

export function ThreadHistoryControl({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex justify-center gap-[var(--space-2)]">{children}</div>
}

export function ThreadEmpty({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="div" size="ui" tone="muted" className="flex flex-1 items-center justify-center p-[var(--space-5)] text-center">{children}</Text>
}

/** The docked input: the message field over its action row. */
export function ThreadComposerFrame({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="flex-none border-t border-[var(--divider)] px-[var(--space-4)] py-[var(--space-3)]">
      <div className="mx-auto flex w-full max-w-[var(--w-thread-column)] flex-col gap-[var(--space-2)]">{children}</div>
    </div>
  )
}

export function ThreadComposerInput({ ref, ...props }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> & { ref?: Ref<HTMLTextAreaElement> }): React.JSX.Element {
  return <textarea {...props} ref={ref} className="block max-h-[var(--h-thread-composer-max)] min-h-[var(--h-ctl)] w-full resize-none overflow-y-auto rounded-[var(--tr-radius-button)] border border-[var(--border)] bg-[var(--card-bg)] px-[var(--space-3)] py-[var(--space-2)] [font-family:inherit] [font-size:var(--tr-text-body-size)] [font-weight:var(--tr-text-body-weight)] leading-[var(--tr-leading-chat-markdown)] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-faint)] focus-visible:border-[var(--border-focus)]" />
}

export function ThreadComposerActions({ hint, children }: { hint?: ReactNode; children: ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center gap-[var(--space-2)]">
      <Text as="div" size="small" tone="faint" className="min-w-0 flex-1 truncate">{hint}</Text>
      {children}
    </div>
  )
}

export function ThreadSpecimen(): React.JSX.Element {
  return (
    <div data-testid="thread-specimen" className="grid max-w-[var(--w-thread-column)] gap-[var(--space-3)]">
      <ThreadUserMessage>Rename the helper and update its callers.</ThreadUserMessage>
      <ThreadAssistantBlock streaming={false}><ThreadPlainText>I renamed it in three files.</ThreadPlainText></ThreadAssistantBlock>
      <ThreadTurnFold label="Worked for 2m 14s · Read 6 files · Changed 2 files" outcome="completed" open onToggle={() => {}} />
      <ThreadReasoningRow label="Thought for 14s · ~800 tokens" live={false} />
      <ThreadReasoningRow label="Thinking · ~50 tokens" live />
      <ThreadWorkRow glyph={IconSquareTerminal} verb="Ran" target="bun run typecheck" state="done" open onToggle={() => {}}>
        <ThreadToolSection label="Output"><ThreadCodeBlock>$ tsc --noEmit</ThreadCodeBlock></ThreadToolSection>
      </ThreadWorkRow>
      <ThreadWorkRow glyph={IconFileText} verb="Read" target="src/main.ts" state="running" open={false} onToggle={() => {}} />
      <ThreadWorkRow glyph={IconSearch} verb="Searched" target="renameHelper" state="unfinished" open={false} onToggle={() => {}} />
      <ThreadWorkRow glyph={IconFileDiff} verb="Edited" target="src/helper.ts" result={<ThreadLineCounts added={4} removed={2} />} state="done" open={false} onToggle={() => {}} />
      <ThreadWorkRow glyph={IconFileDiff} verb="Edited" target="src/missing.ts" state="error" open={false} onToggle={() => {}} />
      <ThreadTurnFold label="Stopped after 41s · Ran 1 command" outcome="interrupted" open={false} onToggle={() => {}} />
      <ThreadTurnFold label="Failed after 3m 02s" outcome="error" open={false} onToggle={() => {}} />
      <ThreadChangedFiles files={[{ path: 'src/helper.ts', glyph: IconFileText, added: 4, removed: 2 }, { path: 'src/callers.ts', glyph: IconFileText, added: 3, removed: 3 }]} onOpen={() => {}} />
      <ThreadNotice>Earlier messages were removed: the thread keeps 20,000 events.</ThreadNotice>
      <ThreadNotice tone="stop">Claude exited with code 1.</ThreadNotice>
      <ThreadStoppedMarker />
      <ThreadApprovalCard name="Bash" summary="rm -rf build" state="pending" actions={<><Button variant="secondary" size="sm">Deny</Button><Button variant="primary" size="sm">Allow</Button></>}>
        <ThreadToolSection label="Command"><ThreadCodeBlock>rm -rf build</ThreadCodeBlock></ThreadToolSection>
        <ThreadApprovalNote>12 KiB more input is not shown; Allow approves it too.</ThreadApprovalNote>
      </ThreadApprovalCard>
      <ThreadApprovalCard name="Write" summary="notes.txt" state="denied" reason="Stopped in Houston before anyone answered." />
      <ThreadComposerFrame>
        <ThreadComposerInput rows={1} placeholder="Message Claude" />
        <ThreadComposerActions hint="Enter sends · Shift+Enter adds a line"><Button variant="primary" size="sm">Send</Button></ThreadComposerActions>
      </ThreadComposerFrame>
    </div>
  )
}
