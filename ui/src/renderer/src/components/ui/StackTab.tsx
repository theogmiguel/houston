import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'
import { Text } from './Text'

export function StackTabStrip({ children, ...rest }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <Text
      as="div"
      {...rest}
      size="small" weight="small"
      className="stack-tabs flex items-stretch h-[var(--h-pill)] flex-none bg-[var(--card-bg)] border-b border-[var(--divider)] overflow-x-auto"
    >
      {children}
    </Text>
  )
}

export function StackTab({ active, children, ...rest }: { active: boolean; children: ReactNode } & HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      {...rest}
      className={`group relative flex items-center gap-1 px-2 h-full [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] whitespace-nowrap cursor-pointer border-r border-[var(--divider)] [transition:background_0.12s_ease-out] ${
        active
          ? 'bg-[var(--content-bg)] text-[var(--text-primary)]'
          : 'text-[var(--text-muted)] hover:bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)]'
      }`}
    >
      {children}
    </div>
  )
}

export function StackTabLabel({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="span" className="max-w-[var(--w-stack-tab-label)] truncate">{children}</Text>
}

/** The warning dot on a background tab whose session needs input. */
export function StackTabBadge(props: HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return <span {...props} className="w-1.5 h-1.5 rounded-full flex-none bg-[var(--warn)]" />
}

export function StackTabClose(props: ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return (
    <button
      {...props}
      className="border-0 bg-transparent opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-[var(--text-faint)] hover:text-[var(--text-primary)]"
    />
  )
}

export function StackTabCapacity({ children, ...rest }: { children: ReactNode } & HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return (
    <Text
      as="span"
      {...rest}
      size="label" weight="label" tone="faint" tabular
      className="flex items-center px-2"
    >
      {children}
    </Text>
  )
}
