import type { HTMLAttributes, ReactNode } from 'react'
import { IconInfo } from '../icons'
import { Icon } from './Icon'
import { Select, type SelectProps } from './Select'
import { Text } from './Text'
import { TaskAgentTag, TaskButton, TaskCheckRow, TaskDot, TaskKeyTag, TaskMono, TaskStateText, TaskTagChip } from './TaskSurface'

// The run cards: the Now card above the list, and the execution and start
// cards in a record.

type DivProps = HTMLAttributes<HTMLDivElement>

const cx = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(' ')

export interface TaskExecCardProps extends DivProps {
  /** The run waits on a person: the border warms. */
  needs?: boolean
  /** A completed run card follows a description with a wider top rhythm. */
  run?: boolean
  /** The record drawer's card: card ground, no side inset. */
  drawer?: boolean
  /** The task's first run card has a wider top rhythm. */
  start?: boolean
}

/** The execution card: a bordered frame with a header, meta rows and an action footer. */
export function TaskExecCard({ needs = false, run = false, drawer = false, start = false, children, ...props }: TaskExecCardProps): React.JSX.Element {
  return (
    <div className={drawer ? 'pt-[var(--space-2-5)] pb-[var(--space-3)]' : cx('px-[var(--space-2-5)] pb-[var(--space-0-5)]', start || run ? 'pt-[var(--space-2-5)]' : 'pt-[var(--space-1-5)]')}>
      <div
        {...props}
        data-presentation={drawer ? 'drawer' : 'default'}
        className={cx(
          'border rounded-[var(--tr-radius-card)] overflow-hidden',
          drawer ? 'bg-[var(--card-bg)]' : 'bg-[var(--content-bg)]',
          needs ? 'border-[var(--task-banner-warn-border)]' : 'border-[var(--border)]'
        )}
      >
        {children}
      </div>
    </div>
  )
}

export function TaskExecHeader({ drawer = false, children }: { drawer?: boolean; children: ReactNode }): React.JSX.Element {
  return (
    <Text as="div" size="sm"
      className={cx(
        'flex items-center',
        drawer
          ? 'h-auto min-h-[var(--task-drawer-header-height)] flex-wrap justify-start gap-[var(--space-1-5)] px-[var(--space-2-5)]'
          : 'gap-[var(--space-2)] h-[var(--task-exec-header-height)] px-[var(--space-2-5)] border-b border-[var(--divider)]'
      )}
    >
      {children}
    </Text>
  )
}

export function TaskExecTitle({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="b" weight="semibold">{children}</Text>
}

export function TaskExecMeta({ children, ...props }: HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return <Text as="span" {...props} tone="muted">{children}</Text>
}

export function TaskReviewVerdict({ tone, children, ...props }: HTMLAttributes<HTMLSpanElement> & { tone: 'done' | 'failed' | 'needs' }): React.JSX.Element {
  return <Text as="span" {...props} data-run-state={tone} tone={tone} className="basis-full">{children}</Text>
}

export function TaskExecReuse({ children, ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <Text as="div" {...props} size="xs" tone="faint" className="px-[var(--space-2-5)] pb-[var(--space-2)]">
      {children}
    </Text>
  )
}

/** The wrapping row of branch, provider and reviewer under an execution header. */
export function TaskExecDetails({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Text as="div" size="sm" tone="secondary" className="flex flex-wrap items-center gap-[var(--space-2)] px-[var(--space-2-5)] py-[var(--space-2)]">
      {children}
    </Text>
  )
}

/** A reason or a reviewer's findings inside a run card. */
export function TaskRunNote({ kind, children, ...props }: DivProps & { kind: 'reason' | 'findings' }): React.JSX.Element {
  const findings = kind === 'findings'
  return (
    <div className="px-[var(--space-2-5)] pb-[var(--space-2)]">
      <div
        {...props}
        className={cx(
          'flex gap-[var(--space-2)] px-[var(--space-2-5)] py-[var(--space-1-5)] rounded-[var(--tr-radius-sm)] bg-[var(--task-run-note-fill)] text-[var(--text-secondary)] [overflow-wrap:anywhere]',
          findings ? 'items-start' : 'items-center'
        )}
      >
        <span className={cx('inline-flex flex-none', findings && 'relative top-[var(--task-check-offset-y)]')}>
          <Icon glyph={IconInfo} role="small" />
        </span>
        <Text as="span" size="sm" tone="secondary" className={cx('min-w-0 flex-1', findings && 'whitespace-pre-wrap')}>{children}</Text>
      </div>
    </div>
  )
}

/** The action row at the foot of a card. */
export function TaskCardActions({ inset = true, children }: { inset?: boolean; children: ReactNode }): React.JSX.Element {
  return (
    <div className={cx('flex items-center gap-1.5 border-t border-[var(--divider)]', inset ? 'px-2.5 py-2' : 'pt-2')}>
      {children}
    </div>
  )
}

/** The agent picker on the start card: wide enough for the longest provider name. */
export function TaskStartSelect(props: Omit<SelectProps, 'className' | 'chrome'>): React.JSX.Element {
  return <Select {...props} className="min-w-[var(--task-control-width)]" />
}

/** The Now card: the focused pane's task, pinned above the list. */
export function TaskNowShell({ children, ...props }: DivProps): React.JSX.Element {
  return (
    <div className="px-[var(--space-2-5)] pt-[var(--space-2)] pb-[var(--space-1)]">
      <div {...props} className="px-[var(--space-3)] py-[var(--space-2-5)] border border-[var(--border)] rounded-[var(--tr-radius-card)] bg-[var(--content-bg)]">
        {children}
      </div>
    </div>
  )
}

export function TaskNowLabel({ label, trailing }: { label: string; trailing: string }): React.JSX.Element {
  return (
    <div className="flex justify-between pb-[var(--space-1-5)]">
      <Text size="label" weight="label" tone="faint" className="uppercase tracking-[var(--task-section-label-tracking)]!">{label}</Text>
      <Text size="label" weight="label" mono tone="faint" caps className="tracking-normal!">{trailing}</Text>
    </div>
  )
}

export function TaskNowTitle({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="div" size="base" weight="semibold" leading="tight" className="pb-[var(--space-1-5)]">{children}</Text>
}

export function TaskNowMeta({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Text as="div" size="meta" tone="muted" className="flex flex-wrap items-center gap-[var(--space-2)]">
      {children}
    </Text>
  )
}

/** Vertical gap above the Now card's checklist or its footer. */
export function TaskNowSection({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="pt-2">{children}</div>
}

export function TaskRunSurfaceSpecimen(): React.JSX.Element {
  return (
    <div className="grid gap-[var(--space-3)] border border-[var(--border)] bg-[var(--card-bg)]">
      <TaskNowShell>
        <TaskNowLabel label="Now · focused pane" trailing="backend" />
        <TaskNowTitle>pane_spawn refuses unsafe worktree slugs</TaskNowTitle>
        <TaskNowMeta>
          <TaskKeyTag>HOU-41</TaskKeyTag>
          <TaskDot tone="needs" />
          <TaskStateText tone="needs">Needs you</TaskStateText>
          <TaskAgentTag agent="claude" label="Claude" size="compact" />
        </TaskNowMeta>
        <TaskNowSection><TaskCheckRow dense checked mark={null} text="Control characters are rejected" /></TaskNowSection>
        <TaskNowSection>
          <TaskCardActions inset={false}>
            <TaskButton tone="primary">Open session</TaskButton>
            <span className="flex-1" />
            <TaskButton tone="ghost">Stop</TaskButton>
          </TaskCardActions>
        </TaskNowSection>
      </TaskNowShell>
      <TaskExecCard run needs>
        <TaskExecHeader>
          <TaskDot tone="needs" />
          <TaskExecTitle>Execution · Attempt 1</TaskExecTitle>
          <TaskStateText tone="needs">Needs you</TaskStateText>
          <span className="flex-1" />
          <TaskMono faint label>8m</TaskMono>
        </TaskExecHeader>
        <TaskExecDetails>
          <TaskTagChip>task/hou-41-slug</TaskTagChip>
          <TaskAgentTag agent="claude" label="Claude" size="compact" />
          <TaskReviewVerdict tone="failed">Review failed</TaskReviewVerdict>
        </TaskExecDetails>
        <TaskRunNote kind="findings">The slug validator accepts a trailing newline.</TaskRunNote>
        <TaskRunNote kind="reason">Waiting for the reviewer.</TaskRunNote>
        <TaskCardActions>
          <TaskButton tone="primary">Open session</TaskButton>
          <span className="flex-1" />
          <TaskButton tone="ghost">Stop</TaskButton>
        </TaskCardActions>
      </TaskExecCard>
      <TaskExecCard drawer>
        <TaskExecHeader drawer>
          <TaskDot tone="idle" />
          <TaskExecTitle>Idle</TaskExecTitle>
          <TaskExecMeta>Stopped 14m ago · Attempt 1</TaskExecMeta>
        </TaskExecHeader>
        <TaskExecReuse>Reuses task worktree · no pull request yet</TaskExecReuse>
      </TaskExecCard>
      <TaskExecCard start>
        <TaskExecHeader>
          <TaskDot tone="idle" />
          <TaskExecTitle>Execution</TaskExecTitle>
          <TaskExecMeta>Not started</TaskExecMeta>
          <span className="flex-1" />
        </TaskExecHeader>
        <TaskCardActions>
          <TaskStartSelect aria-label="Agent" value="claude" options={[{ value: 'claude', label: 'Claude' }]} onChange={() => {}} />
          <TaskButton tone="primary">Start</TaskButton>
        </TaskCardActions>
      </TaskExecCard>
      <TaskStartSelect
        aria-label="Agent"
        value="claude"
        options={[{ value: 'claude', label: 'Claude' }]}
        onChange={() => {}}
      />
    </div>
  )
}
