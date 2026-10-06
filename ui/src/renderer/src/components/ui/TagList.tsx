import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, LabelHTMLAttributes, ReactNode } from 'react'
import { BTN_GHOST } from './buttonChrome'
import { Text } from './Text'
/** The manager dialog's labelled field group. */
export function TagFieldGroup({ children, ...rest }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div {...rest} className="flex flex-col gap-[var(--space-tag-form-gap)]">
      {children}
    </div>
  )
}

export function TagFieldLabel(props: LabelHTMLAttributes<HTMLLabelElement>): React.JSX.Element {
  return (
    <Text
      as="label"
      {...props}
      size="label" weight="label" tone="muted" caps
    />
  )
}

export function TagTextInput(props: InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return (
    <input
      {...props}
      className="w-full bg-background border border-border rounded-[var(--tr-radius-button)] text-text-primary [font:inherit] [font-size:var(--tr-text-ui-size)] [font-weight:var(--tr-text-ui-weight)] px-[var(--space-2-5)] py-[var(--space-1-5)]"
    />
  )
}

export function TagHint({ children, ...rest }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <Text as="div" {...rest} size="small" weight="small" tone="faint" leading="tag-hint">{children}</Text>
  )
}

export function TagFormActions({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex items-center gap-[var(--space-2)] pt-[var(--space-tag-form-actions-top)]">{children}</div>
}

/** Wraps the form preview chip so the named chip may grow to 150px. */
export function TagFormPreview({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <span className="flex items-center [--tag-chip-max:var(--w-tag-form-preview-chip)]" data-testid="tag-form-preview">
      {children}
    </span>
  )
}

/** The bordered, divided list of tag rows. */
export function TagList({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col rounded-[var(--tr-radius-button)] border border-border overflow-hidden [&>*+*]:border-t [&>*+*]:border-divider">
      {children}
    </div>
  )
}

// A tag made from the rail lands in the manager with the ring on its row; it fades itself out.
export function TagListRow({ isNew, children, ...rest }: { isNew: boolean; children: ReactNode } & HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      {...rest}
      className={`group flex items-center gap-[var(--space-2-5)] px-[var(--space-2-5)] h-[var(--h-row)] hover:bg-[var(--hover-fill)] ${isNew ? 'motion-safe:animate-[tag-row-settle_1.4s_var(--animate-ease-panel)_forwards] outline outline-1 outline-[var(--accent)] -outline-offset-1' : ''}`}
    >
      {children}
    </div>
  )
}

export function TagListName({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Text as="span" size="ui" weight="ui" tone="primary" className="flex-1 min-w-0 truncate">
      {children}
    </Text>
  )
}

export function TagListUsage({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <Text as="span" size="caption" weight="label" tone="faint" tabular className="flex-none">
      {children}
    </Text>
  )
}

export function TagRowIconButton({
  danger = false,
  ...rest
}: { danger?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return (
    <button
      {...rest}
      type="button"
      className={`btn ${BTN_GHOST} border-none bg-transparent rounded-[var(--tr-radius-input)] text-[var(--text-faint)] py-0 px-[var(--space-1-5)] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-text-primary ${danger ? 'hover:text-danger' : ''}`.trim()}
    />
  )
}

/** Specimen for the tag roles: chips in each shape, swatches, and a manager row. */
