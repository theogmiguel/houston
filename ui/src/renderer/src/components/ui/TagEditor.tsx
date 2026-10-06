import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, Ref } from 'react'
import { BTN_GHOST, BTN_PRIMARY } from './buttonChrome'
import { Text } from './Text'
/** The floating create/edit popover; `style` carries its runtime position. */
export function TagEditorPopover({
  popRef,
  children,
  ...rest
}: { popRef?: Ref<HTMLDivElement>; children: ReactNode } & HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      {...rest}
      ref={popRef}
      className="fixed z-[var(--z-context)] w-[var(--w-tag-editor)] bg-[var(--raised)] border border-[var(--border)] rounded-[var(--tr-radius-md)] shadow-[var(--shadow-1)] p-[var(--space-tag-editor-padding)] flex flex-col gap-[var(--space-tag-editor-gap)]"
    >
      {children}
    </div>
  )
}

export function TagEditorTitle({ children }: { children: ReactNode }): React.JSX.Element {
  return <Text as="strong" size="small" weight="tag-title" tone="primary">{children}</Text>
}

export function TagEditorInput({ inputRef, ...rest }: { inputRef?: Ref<HTMLInputElement> } & InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return (
    <input
      {...rest}
      ref={inputRef}
      className="w-full h-[var(--h-ctl)] px-[var(--space-2)] rounded-[var(--tr-radius-input)] border border-[var(--border)] bg-[var(--content-bg)] text-[var(--text-primary)] [font-size:var(--tr-text-small-size)] [font-weight:var(--tr-text-small-weight)] outline-none focus-visible:border-[var(--border-hover)]"
    />
  )
}

/** The quiet uppercase caption above a popover section. */
export function TagEditorCaption({ children, inline = false }: { children: ReactNode; inline?: boolean }): React.JSX.Element {
  return <Text as={inline ? 'span' : 'div'} size="label" weight="label" tone="faint" caps style={{ letterSpacing: 'var(--tr-text-tag-caption-tracking)' }}>{children}</Text>
}

export function TagEditorPreviewRow({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex items-center gap-[var(--space-tag-editor-preview-gap)]">{children}</div>
}

export function TagEditorActions({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex justify-end gap-[var(--space-tag-editor-actions-gap)]">{children}</div>
}

export function TagEditorButton({
  variant,
  ...rest
}: { variant: 'ghost' | 'primary' } & ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  const { children, ...buttonProps } = rest
  return <button {...buttonProps} type="button" className={`btn ${variant === 'ghost' ? BTN_GHOST : BTN_PRIMARY} px-[var(--space-3)] py-[var(--space-tag-editor-button-block)] rounded-[var(--tr-radius-button)] ${variant === 'primary' ? 'disabled:opacity-45 disabled:cursor-default' : ''}`}><Text size="small" weight="semibold">{children}</Text></button>
}
