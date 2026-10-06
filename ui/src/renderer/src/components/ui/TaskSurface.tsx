import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, Ref, TextareaHTMLAttributes } from 'react'
import { HIT_TARGET_28 } from '../hitTarget'
import { IconAgent, IconPlus, IconSearch, type IconComponent } from '../icons'
import type { AgentKind } from '../../houston/generated/AgentKind'
import { BTN_GHOST, BTN_PRIMARY, BTN_SECONDARY } from './buttonChrome'
import { Icon } from './Icon'
import { Text } from './Text'
import { OVERLAY_RAISED_ATTRS, OVERLAY_RAISED_CLS } from './overlayChrome'

// The Tasks surfaces: the list, the record header and form, run marks and the
// task menu. Each role is one component so a feature file composes them with
// layout utilities only.

export type TaskTone = 'spawning' | 'working' | 'needs' | 'idle' | 'done' | 'failed'

const cx = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(' ')

type DivProps = HTMLAttributes<HTMLDivElement>
type SpanProps = HTMLAttributes<HTMLSpanElement>

function TaskLabel({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text size="label" weight="label" tone="faint" className="uppercase tracking-[var(--task-section-label-tracking)]!">{children}</Text>
}

/** The scrolling column every Tasks screen sits in. */
export function TaskPanel({ className, ...props }: DivProps): React.JSX.Element {
  return (
    <div
      {...props}
      className={cx('flex-1 min-h-0 min-w-0 flex flex-col overflow-x-hidden overflow-y-auto', className)}
    />
  )
}

/** The 36px header strip: back button, scope, search and the primary action. */
export function TaskToolbar({ className, ...props }: DivProps): React.JSX.Element {
  return (
    <div
      {...props}
      className={cx(
        'flex items-center gap-[var(--space-2)] h-[var(--task-toolbar-height)] min-h-[var(--task-toolbar-height)] pl-[var(--space-3)] pr-[var(--space-1-5)] border-b border-[var(--divider)]',
        className
      )}
    />
  )
}

export function TaskToolbarTitle({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <span className="flex items-center gap-[var(--space-1-5)] min-w-0 whitespace-nowrap">
      <Text as="b" size="sm" weight="semibold" tone="primary" className="overflow-hidden text-ellipsis">{children}</Text>
    </span>
  )
}

export function TaskToolbarFilter({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-[var(--space-1-5)] h-[var(--task-inline-control-height)] px-[var(--space-2)] border border-[var(--border)] rounded-[var(--tr-radius-button)] whitespace-nowrap">
      <Text as="span" size="sm" tone="secondary" className="inline-flex items-center gap-[var(--space-1-5)]">{children}</Text>
    </span>
  )
}

export function TaskSearchField(props: InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return (
    <span className="inline-flex items-center h-[var(--task-inline-control-height)] px-[var(--space-2)] border border-[var(--border)] rounded-[var(--tr-radius-button)] bg-[var(--content-bg)]">
      <input
        {...props}
        className="w-[var(--task-control-width)] h-[var(--h-ctl-mini)] p-0 border-0 bg-transparent text-[var(--text-primary)] text-[length:var(--tr-text-sm)] placeholder:text-[var(--text-faint)]"
      />
    </span>
  )
}

export type TaskButtonTone = 'primary' | 'ghost' | 'secondary'
export type TaskButtonDensity = 'inline' | 'toolbar' | 'form' | 'composer'

const BUTTON_TONE_CLS: Record<TaskButtonTone, string> = {
  primary: `btn ${BTN_PRIMARY}`,
  ghost: `btn ${BTN_GHOST}`,
  secondary: BTN_SECONDARY
}

// The toolbar's `!` weight outranks the primary recipe's own bold.
const BUTTON_DENSITY_CLS: Record<TaskButtonDensity, string> = {
  inline: '',
  toolbar: 'h-[var(--task-inline-control-height)] min-h-[var(--task-inline-control-height)] px-[var(--space-2-5)] py-0',
  form: 'h-[var(--task-inline-control-height)] min-h-[var(--task-inline-control-height)] px-[var(--space-2-5)] py-0',
  composer: 'h-[var(--task-comment-button-height)] min-h-[var(--task-comment-button-height)] px-[var(--space-2-5)] py-0 flex-none'
}

export interface TaskButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  tone: TaskButtonTone
  density?: TaskButtonDensity
}

/** A text button sized for the Tasks surfaces; `density` picks the strip it sits in. */
export function TaskButton({ tone, density = 'inline', className, children, ...props }: TaskButtonProps): React.JSX.Element {
  return (
    <button
      {...props}
      type="button"
      className={cx(BUTTON_TONE_CLS[tone], BUTTON_DENSITY_CLS[density], HIT_TARGET_28, className)}
    >
      {density === 'inline' ? children : <Text as="span" size="sm" weight={density === 'toolbar' ? 'semibold' : undefined} className="inline-flex items-center gap-[var(--space-1-5)]">{children}</Text>}
    </button>
  )
}

export interface TaskIconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  glyph: IconComponent
  /** Hidden until the surrounding `group` is hovered or the button is focused. */
  reveal?: boolean
  ref?: Ref<HTMLButtonElement>
}

/** A 22px icon-only button. */
export function TaskIconButton({ glyph, reveal = false, className, ...props }: TaskIconButtonProps): React.JSX.Element {
  return (
    <button
      {...props}
      type="button"
      className={cx(
        'inline-flex items-center justify-center flex-none size-[var(--h-ctl-mini)] border-0 rounded-[var(--tr-radius-sm)] bg-transparent text-[var(--text-muted)] hover:bg-[var(--hover-fill)] hover:text-[var(--text-primary)]',
        reveal && 'ml-auto opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
        HIT_TARGET_28,
        className
      )}
    >
      <Icon glyph={glyph} role="small" />
    </button>
  )
}

export function TaskSearchIconButton(props: Omit<TaskIconButtonProps, 'glyph'>): React.JSX.Element {
  return <TaskIconButton {...props} glyph={IconSearch} />
}

export function TaskAddIconButton(props: Omit<TaskIconButtonProps, 'glyph'>): React.JSX.Element {
  return <TaskIconButton {...props} glyph={IconPlus} />
}

/** The scroll body of the grouped list. */
export function TaskListBody({ className, ...props }: DivProps): React.JSX.Element {
  return <div {...props} className={cx('flex-[1_0_auto] min-h-0 pb-2', className)} />
}

/** A collapsible group header: chevron, status glyph, label, count and an add button. */
export function TaskGroupHeader({ className, ...props }: DivProps): React.JSX.Element {
  return (
    <Text as="div" size="sm" weight="semibold" tone="secondary"
      {...props}
      className={cx(
        'group flex items-center gap-[var(--space-2)] h-[var(--task-group-header-height)] pl-[var(--space-3)] pr-[var(--space-2-5)] cursor-pointer',
        className
      )}
    />
  )
}

export function TaskGroupSection({ className, ...props }: DivProps): React.JSX.Element {
  return <div {...props} className={cx('pt-[var(--space-0-5)]', className)} />
}

export function TaskGroupChevron({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="span" tone="faint">{children}</Text>
}

export function TaskGroupCount({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Text mono size="xs" weight="medium" tone="faint">{children}</Text>
  )
}

export interface TaskRowProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean
  /** Adds the workspace column. */
  withWorkspace?: boolean
}

/** One task in the list: priority, status, key, title, optional workspace, and a trailing slot. */
export function TaskListRow({ selected = false, withWorkspace = false, className, ...props }: TaskRowProps): React.JSX.Element {
  return (
    <button
      type="button"
      {...props}
        className={cx(
        'grid items-center gap-[var(--space-2)] h-[var(--task-toolbar-height)] mx-[var(--space-1-5)] px-[var(--space-2)] border-0 rounded-[var(--tr-radius-sm)] text-inherit text-left cursor-pointer w-[calc(100%-2*var(--space-1-5))]',
        withWorkspace
          ? 'grid-cols-[var(--task-row-priority-width)_var(--task-row-status-width)_var(--task-row-key-width)_minmax(0,1fr)_auto_auto]'
          : 'grid-cols-[var(--task-row-priority-width)_var(--task-row-status-width)_var(--task-row-key-width)_minmax(0,1fr)_auto]',
        selected
          ? 'bg-[var(--selected-fill)] hover:bg-[var(--selected-fill)]'
          : 'bg-transparent hover:bg-[var(--hover-fill)]',
        className
      )}
    />
  )
}

export function TaskKey({ className, ...props }: SpanProps): React.JSX.Element {
  const { children, ...rest } = props
  return <Text as="span" {...rest} mono size="xs" tone="faint" tabular className={className}>{children}</Text>
}

export function TaskListTitle({ className, ...props }: SpanProps): React.JSX.Element {
  const { children, ...rest } = props
  return <Text as="span" {...rest} size="row" tone="primary" className={cx('min-w-0 overflow-hidden text-ellipsis whitespace-nowrap', className)}>{children}</Text>
}

export function TaskAge({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Text as="span" mono size="xs" tone="faint" tabular className="min-w-[var(--task-age-min-width)] text-right">
      {children}
    </Text>
  )
}

const DOT_TONE_CLS: Record<TaskTone, string> = {
  working: 'bg-[var(--info)]',
  spawning: 'bg-[var(--accent)]',
  needs: 'bg-[var(--warn)]',
  idle: 'bg-[var(--text-muted)]',
  done: 'bg-[var(--ok)]',
  failed: 'bg-[var(--stop)]'
}

/** A 7px state dot. `inset` nudges it down inside a centred icon slot. */
export function TaskDot({ tone, inset = false }: { tone: TaskTone; inset?: boolean }): React.JSX.Element {
  return (
    <span
      className={cx('size-[var(--task-status-dot-size)] flex-none rounded-[var(--tr-radius-pill)]', DOT_TONE_CLS[tone], inset && 'relative top-[var(--task-dot-inset-offset)]')}
    />
  )
}

export function TaskStateText({ tone, children, ...props }: SpanProps & { tone: TaskTone }): React.JSX.Element {
  return (
    <Text as="span" {...props} data-run-state={tone} tone={tone === 'idle' ? 'muted' : tone}>
      {children}
    </Text>
  )
}

/** The dot-and-label cluster at the right of a task row. */
export function TaskLive({ children, ...props }: SpanProps): React.JSX.Element {
  return (
    <Text as="span" {...props} size="meta" weight="semibold" className="inline-flex items-center gap-[var(--space-1-5)] whitespace-nowrap">
      {children}
    </Text>
  )
}

export interface TaskTagChipProps extends SpanProps {
  /** Caps the width for a row that also carries a title. */
  narrow?: boolean
}

/** A monospaced tag for a branch or workspace name. */
export function TaskTagChip({ narrow = false, className, children, ...props }: TaskTagChipProps): React.JSX.Element {
  return (
    <span {...props} className={cx('inline-flex items-center gap-[var(--space-1-5)] h-[var(--h-tag-chip)] px-[var(--space-1-5)] rounded-[var(--tr-radius-sm)] bg-[var(--task-tag-fill)]', narrow ? 'max-w-[var(--task-tag-narrow-max-width)]' : 'max-w-[var(--task-tag-max-width)]', className)}>
      <Text as="span" size="xs" tone="secondary" mono className="flex min-w-0 items-center gap-[var(--space-1-5)]">{children}</Text>
    </span>
  )
}

const KEY_CHIP_CLS = cx(
  'inline-flex items-center gap-[var(--task-tag-gap)] h-[var(--h-tag-chip)] px-[var(--space-1-5)] rounded-[var(--tr-radius-sm)] bg-[var(--task-tag-fill)] border-0 flex-none cursor-pointer text-[length:var(--tr-text-xs)] text-[var(--text-secondary)] font-mono [&_svg]:size-[var(--task-key-icon-size)]',
  'hover:bg-[var(--task-tag-hover-fill)] hover:text-[var(--text-primary)]'
)

export interface TaskKeyChipProps {
  /** Tightens the horizontal padding for a roster row. */
  compact?: boolean
}

/** The bound task's status glyph and key, as a button. */
export function TaskKeyChip({ compact = false, className, children, ...props }: TaskKeyChipProps & ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return <button type="button" {...props} className={cx(KEY_CHIP_CLS, compact && 'px-[var(--task-chip-compact-inset)]', className)}>{children}</button>
}

/** The same chip as static text. */
export function TaskKeyTag({ compact = false, className, children, ...props }: TaskKeyChipProps & SpanProps): React.JSX.Element {
  return (
    <Text
      as="span"
      {...props}
      size="xs"
      tone="secondary"
      mono
      className={cx(KEY_CHIP_CLS, compact && 'px-[var(--task-chip-compact-inset)]', className)}
    >
      {children}
    </Text>
  )
}

/** A provider mark at 14px. */
export function TaskAgentIcon({ agent }: { agent: AgentKind }): React.JSX.Element {
  return <IconAgent agent={agent} brand className="size-[var(--task-agent-icon-size)] flex-none" />
}

/** A provider mark and name, with an optional faint lead-in label. */
export function TaskAgentTag({ agent, label, prefix, size = 'meta', tone = 'muted' }: { agent: AgentKind; label: string; prefix?: string; size?: 'meta' | 'compact'; tone?: 'muted' | 'secondary' }): React.JSX.Element {
  return (
    <Text as="span" size={size === 'compact' ? 'sm' : size} tone={tone} className="inline-flex items-center gap-[var(--space-1-5)]">
      {prefix && <TaskPropKey>{prefix}</TaskPropKey>}
      <TaskAgentIcon agent={agent} />
      {label}
    </Text>
  )
}

// A raised menu opened from a Tasks icon button.
const MENU_ITEM_CLS = 'flex items-center gap-[var(--space-2)] min-h-[var(--h-ctl)] px-[var(--space-2-5)] border-0 rounded-[var(--tr-radius-sm)] bg-transparent text-left text-[var(--text-secondary)] hover:bg-[var(--hover-fill)] hover:text-[var(--text-primary)]'

export function TaskMenuPanel(props: DivProps & { ref?: Ref<HTMLDivElement> }): React.JSX.Element {
  return <div {...OVERLAY_RAISED_ATTRS} {...props} className={cx(OVERLAY_RAISED_CLS, 'fixed z-[var(--z-overlay)] min-w-[var(--task-menu-width)] flex flex-col p-[var(--space-1)]', props.className)} />
}

export function TaskMenuSection({ heading, children }: { heading?: string; children: ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col">
      {heading && <Text as="div" size="label" weight="label" tone="faint" caps className="px-[var(--space-2-5)] pt-[var(--space-1-5)] pb-[var(--space-0-5)] tracking-[var(--task-section-label-tracking)]!">{heading}</Text>}
      {children}
    </div>
  )
}

export interface TaskMenuItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'children'> {
  label: string
  /** The check glyph, drawn in the leading slot when set. */
  mark?: ReactNode
}

export function TaskMenuItem({ label, mark, className, ...props }: TaskMenuItemProps): React.JSX.Element {
  return (
    <button type="button" {...props} className={cx(MENU_ITEM_CLS, 'w-full', className)}>
      <span className="w-[var(--space-3)] flex-none text-[var(--text-primary)]">{mark}</span>
      <Text as="span" size="row" className="min-w-0 flex-1 truncate">{label}</Text>
    </button>
  )
}

// Record header: title, meta line, property chips, sections and body copy.

export function TaskRecordBody({ drawer = false, className, ...props }: DivProps & { drawer?: boolean }): React.JSX.Element {
  return <div {...props} className={cx('flex-[1_0_auto] min-h-0', drawer ? 'px-[var(--space-3)] pt-[var(--space-2)] pb-[var(--space-3)]' : 'pb-[var(--space-2-5)]', className)} />
}

export function TaskTitleField(props: InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return (
    <div className="px-[var(--task-record-inset)] pt-[var(--space-3)] pb-[var(--task-inline-offset-y)]">
      <input
        {...props}
        className="block w-full p-0 border-0 bg-transparent text-[var(--text-primary)] text-[length:var(--task-detail-title-size)] font-[var(--task-detail-title-weight)] tracking-[var(--task-detail-title-tracking)] leading-[var(--task-detail-title-leading)]"
      />
    </div>
  )
}

export function TaskMetaLine({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Text as="div" size="meta" tone="muted" className="flex flex-wrap items-center gap-[var(--space-2)] px-[var(--task-record-inset)] pb-[var(--space-2)]">
      {children}
    </Text>
  )
}

export function TaskMono({ faint = false, label = false, children }: { faint?: boolean; label?: boolean; children: ReactNode }): React.JSX.Element {
  return <Text as="span" mono tone={faint ? 'faint' : undefined} className={label ? 'text-[length:var(--tr-text-label-size)]' : ''}>{children}</Text>
}

export function TaskPropRow({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex flex-wrap gap-[var(--space-1-5)] px-[var(--task-record-inset)] pb-[var(--space-2-5)]">{children}</div>
}

export function TaskProp({ className, ...props }: SpanProps): React.JSX.Element {
  return (
    <span
      {...props}
      className={cx(
        'inline-flex items-center gap-[var(--space-1-5)] h-[var(--task-inline-control-height)] px-[var(--space-2)] border border-[var(--border)] rounded-[var(--tr-radius-button)] whitespace-nowrap text-[length:var(--tr-text-sm)] text-[var(--text-secondary)]',
        className
      )}
    />
  )
}

export function TaskPropKey({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="span" tone="faint">{children}</Text>
}

export function TaskSectionLabel({ heading, trailing }: { heading: string; trailing?: string }): React.JSX.Element {
  return (
    <Text as="div" size="label" weight="label" tone="faint" className="flex justify-between gap-[var(--space-2)] px-[var(--task-record-inset)] pt-[var(--space-2)] pb-[var(--space-1)] uppercase tracking-[var(--task-section-label-tracking)]">
      <TaskLabel>{heading}</TaskLabel>
      {trailing && <Text mono tone="faint" className="tracking-normal! normal-case!">{trailing}</Text>}
    </Text>
  )
}

export function TaskBody({ column = false, className, ...props }: DivProps & { column?: boolean }): React.JSX.Element {
  return (
    <Text as="div" size="row" leading="copy" tone="secondary"
      {...props}
      className={cx('px-[var(--task-record-inset)]', column && 'flex flex-col', className)}
    />
  )
}

export function TaskDescriptionField(props: TextareaHTMLAttributes<HTMLTextAreaElement>): React.JSX.Element {
  return (
    <textarea
      {...props}
      className="block w-[calc(100%-2*var(--task-record-inset))] mx-[var(--task-record-inset)] p-0 border-0 bg-transparent text-[var(--text-secondary)] text-[length:var(--tr-text-row)] leading-[var(--task-copy-leading)] resize-none"
    />
  )
}

// Acceptance checklist rows.
const CHECK_ROW_CLS =
  'flex items-start gap-[var(--space-2)] w-full border-0 bg-transparent text-left'

function CheckBox({ checked, children }: { checked: boolean; children?: ReactNode }): React.JSX.Element {
  return (
    <span
      className={cx(
        'relative top-[var(--task-check-offset-y)] size-[var(--task-check-box-size)] flex-none flex items-center justify-center rounded-[var(--tr-radius-input)] border-[length:var(--task-check-border-width)] text-[var(--content-bg)]',
        checked ? 'bg-[var(--ok)] border-[var(--ok)]' : 'border-[var(--border-focus)]'
      )}
    >
      {children}
    </span>
  )
}

export interface TaskCheckRowProps {
  checked: boolean
  /** A check glyph, drawn only when `checked`. */
  mark: ReactNode
  text: string
  by?: string | null
  /** The tighter vertical rhythm of the Now card. */
  dense?: boolean
}

function CheckContent({ checked, mark, text, by }: TaskCheckRowProps): React.JSX.Element {
  return (
    <>
      <CheckBox checked={checked}>{checked && mark}</CheckBox>
      <Text as="span" tone={checked ? 'muted' : 'secondary'}>{text}</Text>
      {by && (
        <Text as="span" size="xs" tone="faint" className="ml-auto inline-flex items-center gap-[var(--space-1)] pl-[var(--space-2)] whitespace-nowrap">
          {by}
        </Text>
      )}
    </>
  )
}

export function TaskCheckRow(props: TaskCheckRowProps): React.JSX.Element {
  return <Text as="div" size="row" leading="check" tone="secondary" className={cx(CHECK_ROW_CLS, props.dense ? 'py-[var(--task-check-compact-padding-y)]' : 'py-[var(--task-check-padding-y)]')}><CheckContent {...props} /></Text>
}

export function TaskCheckButton({ checked, mark, text, by, dense, ...buttonProps }: TaskCheckRowProps & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'children'>): React.JSX.Element {
  return (
    <button type="button" {...buttonProps} className={cx(CHECK_ROW_CLS, 'text-[length:var(--tr-text-row)] leading-[var(--task-check-leading)] text-[var(--text-secondary)]', dense ? 'py-[var(--task-check-compact-padding-y)]' : 'py-[var(--task-check-padding-y)]')}>
      <CheckContent checked={checked} mark={mark} text={text} by={by} />
    </button>
  )
}

// Banners.
export function TaskBanner({ tone = 'warn', children, ...props }: DivProps & { tone?: 'warn' | 'error' }): React.JSX.Element {
  return (
    <div className="px-2.5 pt-1.5 pb-0.5">
      <Text as="div" size="sm" tone="secondary"
        {...props}
        className={cx(
          'flex items-center gap-[var(--space-2)] px-[var(--space-2-5)] py-[var(--space-1-5)] border rounded-[var(--tr-radius-card)]',
          tone === 'error'
            ? 'border-[var(--task-banner-error-border)] bg-[var(--task-banner-error-fill)]'
            : 'border-[var(--task-banner-warn-border)] bg-[var(--task-banner-warn-fill)]'
        )}
      >{children}</Text>
    </div>
  )
}

export function TaskBannerMessage({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="flex-1 min-w-0 [overflow-wrap:anywhere]">{children}</span>
}

export function TaskBannerDetail({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="span" size="xs" tone="faint" className="block">{children}</Text>
}

// Activity feed.
export function TaskActivityRow({ className, ...props }: DivProps): React.JSX.Element {
  return (
    <Text as="div" size="sm" leading="activity" tone="secondary"
      {...props}
      className={cx('flex gap-[var(--space-2-5)] px-[var(--task-record-inset)] py-[var(--task-activity-row-padding-y)]', className)}
    />
  )
}

export function TaskActivityIcon({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <span className="w-[var(--task-activity-icon-size)] h-[var(--task-activity-icon-box-height)] pt-[var(--task-activity-icon-offset-y)] flex-none flex items-center justify-center text-[var(--text-muted)]">
      {children}
    </span>
  )
}

export function TaskActivityActor({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="b" weight="semibold" tone="primary">{children}</Text>
}

export function TaskActivityTime({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Text as="span" mono size="xs" tone="faint" className="ml-auto pl-[var(--space-2)] whitespace-nowrap">
      {children}
    </Text>
  )
}

export function TaskActivityBubble({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="pt-[var(--space-1)]">
      <Text as="div" size="sm" tone="secondary" className="px-[var(--space-2-5)] py-[var(--space-1-5)] border border-[var(--divider)] rounded-[var(--tr-radius-md)] bg-[var(--content-bg)] [overflow-wrap:anywhere] whitespace-pre-wrap">
        {children}
      </Text>
    </div>
  )
}

/** The small caps tag a system-written entry carries. */
export function TaskSystemMark({ size = 'xs', children }: { size?: 'xs' | 'system'; children: ReactNode }): React.JSX.Element {
  return (
    <span className="pl-[var(--space-1-5)]">
      <Text as="span" size={size} weight="bold" tone="faint" caps className="border border-[var(--divider)] rounded-[var(--tr-radius-input)] px-[var(--space-1)]">
        {children}
      </Text>
    </span>
  )
}

// Comment composer.
export function TaskCommentBox({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="px-[var(--space-2-5)] pt-[var(--space-1-5)]">
      <div className="flex items-center justify-between gap-[var(--space-2)] py-[var(--space-1)] pr-[var(--space-1)] pl-[var(--space-2-5)] border border-[var(--border)] rounded-[var(--tr-radius-button)] bg-[var(--content-bg)]">
        {children}
      </div>
    </div>
  )
}

export function TaskCommentField(props: TextareaHTMLAttributes<HTMLTextAreaElement>): React.JSX.Element {
  return (
    <textarea
      {...props}
      className="flex-1 min-w-0 min-h-[var(--task-comment-field-min-height)] max-h-[var(--task-comment-max-height)] py-[var(--space-1)] px-0 border-0 bg-transparent text-[var(--text-primary)] text-[length:var(--tr-text-row)] resize-none placeholder:text-[var(--text-faint)]"
    />
  )
}

// Create form.
export function TaskForm({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex flex-col gap-2.5 px-3.5 pt-3 pb-1">{children}</div>
}

export function TaskFormField({ label, children }: { label: string; children: ReactNode }): React.JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <TaskLabel>{label}</TaskLabel>
      {children}
    </label>
  )
}

export function TaskFormSection({ label, children }: { label: string; children: ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <TaskLabel>{label}</TaskLabel>
      {children}
    </div>
  )
}

const INPUT_CLS =
  'w-full px-2 py-1.5 border border-[var(--border)] rounded-[var(--tr-radius-sm)] bg-[var(--content-bg)] text-[var(--text-primary)] text-[length:var(--tr-text-row)]'

export function TaskFieldInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return <input {...props} className={cx(INPUT_CLS, className)} />
}

export function TaskTextarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>): React.JSX.Element {
  return <textarea {...props} className={cx(INPUT_CLS, 'min-h-[var(--task-description-min-height)] leading-[var(--task-copy-leading)] resize-y', className)} />
}

export function TaskFormRow({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>
}

export function TaskFormActions({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex items-center justify-end gap-2 pt-1 pb-2.5">{children}</div>
}

export function TaskSurfaceSpecimen(): React.JSX.Element {
  return (
    <div className="grid gap-[var(--space-3)] border border-[var(--border)] bg-[var(--card-bg)]">
      <TaskToolbar>
        <TaskToolbarTitle>New task</TaskToolbarTitle>
        <span className="flex-1" />
        <TaskToolbarFilter>All statuses</TaskToolbarFilter>
        <TaskSearchIconButton aria-label="Search tasks" />
        <TaskButton tone="primary" density="toolbar">New task</TaskButton>
      </TaskToolbar>
      <TaskMenuPanel role="menu" className="!static">
        <TaskMenuSection heading="Agent access">
          <TaskMenuItem role="menuitemradio" aria-checked label="Read and write" mark="✓" />
        </TaskMenuSection>
      </TaskMenuPanel>
      <TaskGroupSection>
        <TaskGroupHeader>
          <TaskGroupChevron>v</TaskGroupChevron>
          <span>In progress</span>
          <TaskGroupCount>2</TaskGroupCount>
          <TaskAddIconButton aria-label="New task" reveal />
        </TaskGroupHeader>
        <TaskListRow>
          <span />
          <span />
          <TaskKey>HOU-41</TaskKey>
          <TaskListTitle>pane_spawn refuses unsafe worktree slugs</TaskListTitle>
          <TaskLive>
            <TaskDot tone="needs" />
            <TaskStateText tone="needs">Needs you</TaskStateText>
          </TaskLive>
        </TaskListRow>
      </TaskGroupSection>
      <TaskListRow selected withWorkspace><span /><span /><TaskKey>HOU-43</TaskKey><TaskListTitle>Regression test</TaskListTitle><TaskTagChip narrow>houston</TaskTagChip><TaskAge>1h</TaskAge></TaskListRow>
      <div className="flex items-center gap-[var(--space-2)] px-3.5">
        <TaskKeyChip>HOU-41</TaskKeyChip>
        <TaskKeyTag compact>HOU-42</TaskKeyTag>
        <TaskTagChip>task/hou-41-slug</TaskTagChip>
        <TaskAge>8m</TaskAge>
      </div>
      <TaskMetaLine>
        <span>created by you</span>
        <TaskMono>revision 9</TaskMono>
      </TaskMetaLine>
      <TaskPropRow>
        <TaskProp><TaskPropKey>Reviewer</TaskPropKey>Codex</TaskProp>
      </TaskPropRow>
      <TaskSectionLabel heading="Acceptance" trailing="2 / 3" />
      <TaskBody column>
        <TaskCheckRow checked mark={<span>x</span>} text="Control characters are rejected" by="You" />
        <TaskCheckRow checked={false} mark={null} text="Regression test fails before the fix" />
      </TaskBody>
      <TaskBanner><TaskBannerMessage>This task changed elsewhere</TaskBannerMessage><TaskButton tone="secondary" density="form">Reload</TaskButton></TaskBanner>
      <TaskBanner tone="error"><TaskBannerMessage>Task limit reached</TaskBannerMessage></TaskBanner>
      <TaskActivityRow>
        <TaskActivityIcon><TaskDot tone="working" inset /></TaskActivityIcon>
        <span><TaskActivityActor>Houston</TaskActivityActor> started<TaskSystemMark size="system">system</TaskSystemMark></span>
        <TaskActivityTime>8m</TaskActivityTime>
      </TaskActivityRow>
      <TaskCommentBox>
        <TaskCommentField aria-label="Leave a comment" placeholder="Leave a comment…" />
        <TaskButton tone="secondary" density="composer">Comment</TaskButton>
      </TaskCommentBox>
      <TaskForm>
        <TaskFormField label="Title"><TaskFieldInput aria-label="Task title" defaultValue="Refuse unsafe slugs" /></TaskFormField>
        <TaskFormField label="Description"><TaskTextarea aria-label="Task description" defaultValue="The error names the slug." /></TaskFormField>
        <TaskFormActions>
          <TaskButton tone="ghost" density="form">Cancel</TaskButton>
          <TaskButton tone="primary" density="form">Create task</TaskButton>
        </TaskFormActions>
      </TaskForm>
    </div>
  )
}
