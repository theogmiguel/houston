import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { FOCUS_HALO, RING_ACCENT_SOLID } from './shadowChrome'
import { Text } from './Text'

export type RadioCardEmphasis = 'subtle' | 'raised'

export type RadioCardProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'type'> & {
  selected: boolean
  emphasis?: RadioCardEmphasis
  children: ReactNode
  className?: string
  type?: ButtonHTMLAttributes<HTMLButtonElement>['type']
}

export function RadioCard({ selected, emphasis = 'subtle', children, className = '', type = 'button', ...props }: RadioCardProps): React.JSX.Element {
  const selectedStyle = selected
    ? emphasis === 'raised'
      ? `border-[var(--accent)] shadow-[${RING_ACCENT_SOLID}] bg-[var(--card-bg)] focus-visible:shadow-[${RING_ACCENT_SOLID},${FOCUS_HALO}]`
      : 'border-[var(--accent)] bg-[var(--card-bg)]'
    : 'border-[var(--border)] hover:border-[var(--border-hover)] bg-[var(--card-bg)]'
  const focus = emphasis === 'subtle' ? `focus-visible:shadow-[${FOCUS_HALO}]` : ''
  const motion = emphasis === 'raised' ? '[transition:border-color_.12s_ease,transform_.12s_ease] motion-safe:hover:-translate-y-px' : '[transition:border-color_.12s_ease]'
  return <button {...props} type={type} role="radio" aria-checked={selected} className={`btn flex flex-col p-0 overflow-hidden rounded-[var(--tr-radius-card)] border text-left whitespace-normal ${focus} ${motion} ${selectedStyle} ${className}`}>{children}</button>
}

export interface ChoiceGridProps {
  children: ReactNode
  columns: 2 | 3
  spacing?: 'relaxed' | 'inset'
  role?: 'radiogroup'
  'aria-label'?: string
}

export function ChoiceGrid({ children, columns, spacing = 'relaxed', role, 'aria-label': ariaLabel }: ChoiceGridProps): React.JSX.Element {
  const columnClass = columns === 2 ? 'grid-cols-[repeat(2,minmax(0,1fr))]' : 'grid-cols-[repeat(3,minmax(0,1fr))]'
  const style = spacing === 'relaxed' ? { marginBlockStart: 'var(--space-2)', marginBlockEnd: 'var(--space-4)' } : undefined
  return <div role={role} aria-label={ariaLabel} style={style} className={`grid ${columnClass} ${spacing === 'inset' ? 'gap-[var(--space-2)] px-[var(--space-4)] pt-[var(--space-3)] pb-[var(--space-4)]' : 'gap-[var(--space-3)]'}`}>{children}</div>
}

export function RadioCardSpecimen(): React.JSX.Element {
  return <div className="grid grid-cols-2 gap-[var(--space-2)]"><RadioCard selected emphasis="raised" onClick={() => {}}><ThemePreviewSwatch theme="graphite" /><RadioCardFooter label="Graphite" tag="Default" selected /></RadioCard><RadioCard selected={false} onClick={() => {}}><ThemePreviewSwatch theme="paper" /><RadioCardFooter label="Paper" tag="Light" selected={false} /></RadioCard></div>
}

export function ThemePreviewSwatch({ theme, 'data-testid': testId }: { theme: 'graphite' | 'paper'; 'data-testid'?: string }): React.JSX.Element {
  return <span data-theme={theme} data-testid={testId} className="flex h-[var(--h-theme-preview)] w-full flex-col justify-between p-[var(--space-2)] bg-[var(--content-bg)]">
    <span className="block h-[var(--h-theme-preview-mark)] w-3/5 rounded-[var(--tr-radius-theme-preview)] bg-[var(--accent)]" />
    <span className="flex gap-[var(--space-theme-preview-line)]"><i className="block h-[var(--h-theme-preview-mark)] w-[var(--h-theme-preview-mark)] rounded-full bg-[var(--text-primary)]" /><i className="block h-[var(--h-theme-preview-mark)] w-[var(--h-theme-preview-mark)] rounded-full bg-[var(--text-secondary)]" /><i className="block h-[var(--h-theme-preview-mark)] w-[var(--h-theme-preview-mark)] rounded-full bg-[var(--border)]" /></span>
  </span>
}

export function RadioCardFooter({ label, tag, selected, testId }: { label: string; tag: string; selected: boolean; testId?: string }): React.JSX.Element {
  return <span className="flex w-full items-center justify-between gap-[var(--space-1-5)] border-t border-t-[var(--divider)] px-[var(--space-2-5)] py-[var(--space-2)]">
    <Text size="small" weight="medium" tone="primary" className="min-w-0 truncate">{label}</Text>
    <Text size="label" weight="label" tone={selected ? 'accent' : 'faint'} mono data-testid={testId}>{tag}</Text>
  </span>
}
