import type { ReactNode } from 'react'
import { Text } from './Text'

const FOOTER_MIN_CLS = 'min-h-[var(--h-list-row-footer)]'

/** A stacked list row: head line, detail line, footer with hover actions. */
export function ListRow({ children, ...rest }: { children: ReactNode } & Record<`data-${string}`, string | undefined>): React.JSX.Element {
  return (
    <div
      {...rest}
      className="group/row relative px-[var(--space-list-row-inline)] py-[var(--space-list-row-block)] [&+&]:border-t [&+&]:border-t-[var(--divider)] hover:bg-[var(--hover-fill)] focus-within:bg-[var(--hover-fill)] block"
    >
      {children}
    </div>
  )
}

export function ListRowTitle({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="strong" size="ui" weight="semibold" leading="snug" tone="primary" className="truncate">{children}</Text>
}

export function ListRowDetail({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Text as="div" size="small" weight="small" leading="snug" tone="secondary" className="truncate pt-[var(--space-list-row-detail-top)]">
      {children}
    </Text>
  )
}

export function ListRowFooter({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="pt-[var(--space-list-row-footer-top)]">
      <Text as="div" size="small" weight="small" tone="secondary" className={`flex items-center ${FOOTER_MIN_CLS}`}>
        {children}
      </Text>
    </div>
  )
}

/** Icon actions that appear while the row is hovered or holds focus. */
export function ListRowActions({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="ml-auto flex items-center gap-[var(--space-list-row-action-gap)] opacity-0 [transition:opacity_0.1s_ease-out] group-hover/row:opacity-100 group-focus-within/row:opacity-100">
      {children}
    </div>
  )
}

/** The run list under a row: its loading, empty and populated states. */
export function RunHistory({ state, children, 'data-testid': testId }: { state: 'loading' | 'empty' | 'list'; children: ReactNode; 'data-testid'?: string }): React.JSX.Element {
  const tone = state === 'loading' ? 'muted' : 'faint'
  return <Text as="div" size={state === 'list' ? undefined : 'small'} tone={state === 'list' ? undefined : tone} data-testid={testId} className="flex flex-col gap-[var(--space-run-history-gap)] pt-[var(--space-run-history-top)]">{children}</Text>
}
