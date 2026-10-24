import type { ReactNode, Ref, TextareaHTMLAttributes } from 'react'
import { IconCheck, IconChevronDown, IconChevronRight, IconInfo, IconShieldAlert, IconStopCircle, IconWrench, type IconComponent } from '../icons'
import { Button } from './Button'
import { Icon } from './Icon'
import { Prose } from './Prose'
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

const TOOL_STATE_WORD: Record<ThreadToolState, string | null> = { running: 'Working', done: null, error: 'Failed', unfinished: 'No result' }

export function ThreadToolCard({ glyph = IconWrench, name, summary, state, open, onToggle, children }: {
  glyph?: IconComponent
  name: string
  summary: string
  state: ThreadToolState
  open: boolean
  onToggle: () => void
  children?: ReactNode
}): React.JSX.Element {
  const word = TOOL_STATE_WORD[state]
  return (
    <div data-thread-item="tool" data-tool-state={state} className="min-w-0 overflow-hidden rounded-[var(--tr-radius-button)] border border-[var(--border)] bg-[var(--card-bg)]">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className={`flex min-h-[var(--h-ctl)] w-full min-w-0 items-center gap-[var(--space-2)] border-0 bg-transparent px-[var(--space-2)] text-left text-[var(--text-secondary)] hover:bg-[var(--hover-fill)] hover:text-[var(--text-primary)] focus-visible:outline-none ${FOCUS_RING_ACCENT_INSET_45_CLS}`}
      >
        <Icon glyph={open ? IconChevronDown : IconChevronRight} role="small" className="flex-none text-[var(--text-faint)]" />
        <Icon glyph={glyph} role="small" className="flex-none" />
        <Text as="span" size="small" weight="semibold" tone="primary" className="flex-none">{name}</Text>
        <Text as="span" size="small" tone="muted" mono className="min-w-0 flex-1 truncate">{summary}</Text>
        {word && <Text as="span" size="small" tone={state === 'error' ? 'stop' : state === 'running' ? 'info' : 'faint'} className="flex-none">{word}</Text>}
      </button>
      {open && <div className="flex flex-col gap-[var(--space-2)] border-t border-[var(--divider)] p-[var(--space-2)]">{children}</div>}
    </div>
  )
}

export type ThreadApprovalState = 'pending' | 'allowed' | 'denied' | 'withdrawn'

const APPROVAL_WORD: Record<ThreadApprovalState, string> = { pending: 'Waiting for you', allowed: 'Allowed', denied: 'Denied', withdrawn: 'Not answered' }

/** Claude asks to run a tool: the request, its input and, while pending, the answers. */
export function ThreadApprovalCard({ name, summary, state, reason, actions, children }: {
  name: string
  summary: string
  state: ThreadApprovalState
  reason?: string | null
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
        <Text as="div" role="status" size="small" tone={pending ? 'secondary' : 'muted'} className="min-w-0 flex-1 break-words">
          {APPROVAL_WORD[state]}{!pending && reason ? ` · ${reason}` : ''}
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
      <ThreadToolCard name="Bash" summary="bun run typecheck" state="done" open onToggle={() => {}}>
        <ThreadToolSection label="Output"><ThreadCodeBlock>$ tsc --noEmit</ThreadCodeBlock></ThreadToolSection>
      </ThreadToolCard>
      <ThreadToolCard name="Read" summary="src/main.ts" state="running" open={false} onToggle={() => {}} />
      <ThreadToolCard name="Edit" summary="src/missing.ts" state="error" open={false} onToggle={() => {}} />
      <ThreadNotice>Earlier messages were removed: the thread keeps 20,000 events.</ThreadNotice>
      <ThreadNotice tone="stop">Claude exited with code 1.</ThreadNotice>
      <ThreadStoppedMarker />
      <ThreadApprovalCard name="Bash" summary="rm -rf build" state="pending" actions={<><Button variant="secondary" size="sm">Deny</Button><Button variant="primary" size="sm">Allow</Button></>}>
        <ThreadToolSection label="Command"><ThreadCodeBlock>rm -rf build</ThreadCodeBlock></ThreadToolSection>
      </ThreadApprovalCard>
      <ThreadApprovalCard name="Write" summary="notes.txt" state="denied" reason="Stopped in Houston before anyone answered." />
      <ThreadComposerFrame>
        <ThreadComposerInput rows={1} placeholder="Message Claude" />
        <ThreadComposerActions hint="Enter sends · Shift+Enter adds a line"><Button variant="primary" size="sm">Send</Button></ThreadComposerActions>
      </ThreadComposerFrame>
    </div>
  )
}
