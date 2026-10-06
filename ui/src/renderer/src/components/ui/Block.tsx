import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'
import { Text } from './Text'

const BAR_EDGE = {
  bottom: 'border-b border-[var(--divider)]',
  top: 'border-t border-[var(--divider)]',
  rows: 'border-t border-[var(--divider)] first:border-t-0'
} as const

const BAR_PAD = {
  md: 'px-[var(--space-panel-detail-x)] py-[var(--space-panel-textarea-y)]',
  lg: 'px-[var(--space-panel-detail-x)] py-[var(--space-block-bar-y-large)]'
} as const

export interface BlockBarProps extends HTMLAttributes<HTMLElement> {
  as?: 'div' | 'li'
  edge: keyof typeof BAR_EDGE
  pad?: keyof typeof BAR_PAD
  text?: 'inherit' | 'plain' | 'faint' | 'small'
}

/** A full-width strip inside a Card block, separated from its neighbours by a divider. */
export function BlockBar({ as: Tag = 'div', edge, pad = 'md', text = 'inherit', className = '', children, ...props }: BlockBarProps): React.JSX.Element {
  const classes = `${BAR_PAD[pad]} ${BAR_EDGE[edge]} ${className}`
  if (text === 'inherit' || text === 'plain') return <Tag {...props} className={classes}>{children}</Tag>
  return <Text as={Tag} {...props} size="small" weight="small" tone={text === 'faint' ? 'faint' : undefined} className={classes}>{children}</Text>
}

const ROW_BASE = 'group/row relative px-[var(--space-panel-detail-x)] py-[var(--space-block-row-y)] [&+&]:border-t [&+&]:border-t-[var(--divider)] hover:bg-[var(--hover-fill)] focus-within:bg-[var(--hover-fill)] flex items-start gap-[var(--space-block-row-gap)]'

/** A list row in a Card block: tile, title, detail and hover-revealed actions. */
export function BlockRow({ className = '', ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div {...props} className={`${ROW_BASE} ${className}`} />
}

/** The leading icon tile of a BlockRow, nudged 1px to sit on the title's cap height. */
export function BlockRowTile({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <span aria-hidden="true" className="flex flex-none pt-px">
      <span className="inline-flex items-center justify-center w-[var(--w-block-row-icon)] h-[var(--h-block-row-icon)] rounded-[var(--tr-radius-sm)] bg-[var(--hover-fill)] text-[var(--text-secondary)]">{children}</span>
    </span>
  )
}

export function BlockRowTitle({ className = '', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return (
    <button
      type="button"
      {...props}
      className={`btn truncate [font-size:var(--tr-text-ui-size)] font-semibold leading-[1.35] text-[var(--text-primary)] flex-1 min-w-0 text-left border-0 bg-transparent p-0 cursor-pointer ${className}`}
    ><Text size="ui" weight="semibold" leading="snug" tone="primary" className="contents">{children}</Text></button>
  )
}

export function BlockRowDetail({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="div" size="small" weight="small" leading="snug" tone="secondary" className="truncate whitespace-normal line-clamp-2">{children}</Text>
}

/** The row's last line: a monospace identifier on the left, actions on the right. */
export function BlockRowMeta({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex items-center min-h-[var(--h-block-row-meta)]">{children}</div>
}

export function BlockRowActions({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="ml-auto flex items-center gap-[var(--space-block-action-gap)] opacity-0 [transition:opacity_0.1s_ease-out] group-hover/row:opacity-100 group-focus-within/row:opacity-100">
      {children}
    </div>
  )
}

const CODE_BASE = 'm-0 overflow-auto rounded-[var(--tr-radius-sm)] border border-[var(--border)] bg-[var(--content-bg)] font-mono whitespace-pre-wrap break-words'

const CODE_SIZE = {
  diff: 'max-h-[var(--h-code-diff-max)] p-2',
  preview: 'max-h-[var(--h-code-diff-max)] p-2',
  'preview-tall': 'max-h-[var(--h-code-preview-tall-max)] p-2',
  instructions: 'flex-1 min-h-[var(--h-code-instructions-min)] max-h-[var(--h-code-instructions-max)] py-[var(--space-code-instructions-y)] px-[var(--space-panel-detail-x)]'
} as const

export interface CodePaneProps extends HTMLAttributes<HTMLPreElement> {
  size: keyof typeof CODE_SIZE
  tone?: 'secondary' | 'danger'
}

/** A bounded, scrollable monospace pane for file content and diffs. */
export function CodePane({ size, tone = 'secondary', className = '', children, ...props }: CodePaneProps): React.JSX.Element {
  return <Text as="pre" {...props} size={size === 'diff' ? undefined : 'small'} leading={size === 'instructions' ? 'relaxed' : 'normal'} tone={tone === 'danger' ? 'danger' : 'secondary'} mono className={`${CODE_BASE} ${CODE_SIZE[size]} ${className}`}>{children}</Text>
}

/** A file path shown beside an action, capped so it cannot push the action out. */
export function BlockPathLabel({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Text as="span" size="small" tone="faint" mono className="flex-none truncate max-w-[var(--w-block-path)]">{children}</Text>
  )
}

/** The fixed-width name column of a BlockBar list row, so the columns after it line up. */
export function BlockLabelCell({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="span" weight="semibold" tone="primary" className="flex-none w-[var(--w-block-label)]">{children}</Text>
}

/** A single-column list of divider-separated bars inside a Card block. */
export function BlockBarList({ children }: { children: ReactNode }): React.JSX.Element {
  return <ul className="flex flex-col">{children}</ul>
}
